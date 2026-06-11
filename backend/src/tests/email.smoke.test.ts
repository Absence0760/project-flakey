/**
 * Email-delivery smoke tests, end-to-end through the local Mailpit sink.
 *
 * The auth flows send mail fire-and-forget (`sendEmail(...).catch(...)` —
 * never awaited), so every other test file can only assert the HTTP status
 * of register / forgot-password / resend-verification. None of them prove an
 * email actually went out, that it was addressed to the right person, or that
 * the link inside it works. This file closes that gap by asserting against the
 * mail that really landed in Mailpit (the SMTP sink `pnpm db:up` starts on
 * :1025 / web+API :8025), and by driving the verify / reset tokens lifted out
 * of the message body back through the API to prove the round-trip.
 *
 * Prereqs (same as the other smoke tests): `pnpm db:up` (Postgres + Mailpit)
 * and a seeded DB. The backend points at Mailpit via the SMTP_HOST/SMTP_PORT
 * defaults (localhost:1025); override MAILPIT_URL if the web API isn't on
 * the default :8025.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3968;
const BASE = `http://localhost:${PORT}`;
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

// Deterministic values for the spawned backend so the assertions below
// don't depend on whatever EMAIL_FROM / FRONTEND_URL the dev shell happens
// to carry. The link tokens are 32-byte hex (crypto.randomBytes(32)).
const FROM_ADDRESS = "ci-noreply@flakey.test";
const FRONTEND_URL = "http://localhost:7778";

let server: ChildProcess;

interface MailpitSummary {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
}
interface MailpitMessage extends MailpitSummary {
  Text: string;
  HTML: string;
}

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MAILPIT}${path}`, init);
  if (!res.ok) throw new Error(`Mailpit ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function assertMailpitReachable(maxMs = 15000): Promise<void> {
  // Poll rather than one-shot: in CI the Mailpit service container is started
  // without a health gate, so it may still be coming up as the job begins.
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await mailpit("/api/v1/messages");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `Mailpit not reachable at ${MAILPIT}. Run \`pnpm db:up\` (it starts Mailpit) ` +
      `or set MAILPIT_URL. These tests assert real delivery, so they cannot run without it.`,
  );
}

async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}

/** List every message currently addressed to `to` (lower-cased compare). */
async function messagesTo(to: string): Promise<MailpitSummary[]> {
  const { messages } = await mailpit<{ messages: MailpitSummary[] }>("/api/v1/messages?limit=200");
  const needle = to.toLowerCase();
  return messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === needle));
}

/**
 * Poll until a message to `to` (optionally matching `subjectIncludes`) lands,
 * then return the FULL message (with Text/HTML). Polling — not a fixed sleep —
 * because the send is fire-and-forget and arrives a beat after the HTTP 200.
 */
async function waitForMail(
  to: string,
  subjectIncludes: string,
  maxMs = 8000,
): Promise<MailpitMessage> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const hits = (await messagesTo(to)).filter((m) => m.Subject.includes(subjectIncludes));
    if (hits.length > 0) {
      return mailpit<MailpitMessage>(`/api/v1/message/${hits[0].ID}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No "${subjectIncludes}" email to ${to} arrived within ${maxMs}ms`);
}

async function register(email: string, password: string): Promise<Response> {
  return fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Email Tester", org_name: `EmailOrg-${email}` }),
  });
}

const tokenFrom = (body: string, path: string): string => {
  const m = body.match(new RegExp(`${path}\\/([a-f0-9]{64})`));
  if (!m) throw new Error(`no ${path} token in email body:\n${body}`);
  return m[1];
};

before(async () => {
  await assertMailpitReachable();
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "email-smoke-test-secret",
      ALLOW_REGISTRATION: "true",
      // This suite asserts delivery + token round-trip mechanics, where the
      // resend test fires immediately after register. Disable the per-email
      // resend cooldown here so that's about delivery, not throttling — the
      // cooldown has its own dedicated coverage in
      // register_verification_gate.smoke.test.ts.
      EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: "0",
      NODE_ENV: "test",
      // Point the mailer at Mailpit (defaults already match, set explicitly
      // for clarity) and pin From/FRONTEND_URL so the assertions are stable.
      SMTP_HOST: process.env.SMTP_HOST ?? "localhost",
      SMTP_PORT: process.env.SMTP_PORT ?? "1025",
      EMAIL_FROM: `Flakey CI <${FROM_ADDRESS}>`,
      FRONTEND_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Verification email on registration ───────────────────────────────────

test("registration delivers a verification email whose link verifies the account", async () => {
  await clearMailbox();
  const email = `verify+${Date.now()}@flakey.test`;
  const reg = await register(email, "verifyme123");
  assert.equal(reg.status, 201, "registration should succeed");

  const mail = await waitForMail(email, "Verify your email");

  // Addressed to the registrant, from the configured sender.
  assert.equal(mail.To[0].Address, email, "verification mail must go to the registrant");
  assert.equal(mail.From.Address, FROM_ADDRESS, "From must be the configured EMAIL_FROM");
  // Both bodies present; HTML carries the clickable link, text the bare URL.
  assert.match(mail.Text, /verify-email\//, "text body must contain the verify link");
  assert.match(mail.HTML, /verify-email\//, "html body must contain the verify link");
  assert.match(mail.Text, /expires in 24 hours/i, "copy must state the 24h expiry");

  // The token in the email must actually verify the account.
  const token = tokenFrom(mail.Text, "verify-email");
  const verify = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verify.status, 200, "emailed verification token must be accepted");
  const body = (await verify.json()) as { ok: boolean; email: string };
  assert.equal(body.ok, true);
  assert.equal(body.email.toLowerCase(), email.toLowerCase());
});

// ── Password-reset email ─────────────────────────────────────────────────

test("forgot-password delivers a reset email whose token actually resets the password", async () => {
  const email = `reset+${Date.now()}@flakey.test`;
  const oldPassword = "originalpass123";
  const newPassword = "brand-new-pass456";
  assert.equal((await register(email, oldPassword)).status, 201);

  await clearMailbox();
  const forgot = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(forgot.status, 200);

  const mail = await waitForMail(email, "Reset your password");
  assert.equal(mail.To[0].Address, email);
  assert.match(mail.Text, /expires in 1 hour/i, "copy must state the 1h expiry");

  const token = tokenFrom(mail.Text, "reset-password");
  const reset = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: newPassword }),
  });
  assert.equal(reset.status, 200, "emailed reset token must be accepted");

  // New password works; old password no longer does — proves the reset
  // actually took effect, not just that the endpoint returned 200.
  const newLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword }),
  });
  assert.equal(newLogin.status, 200, "login with the reset password should succeed");
  const oldLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: oldPassword }),
  });
  assert.equal(oldLogin.status, 401, "the old password must stop working after reset");
});

// ── Enumeration resistance at the delivery layer ─────────────────────────

test("forgot-password for an unknown email sends NO mail (enumeration resistance)", async () => {
  const known = `known+${Date.now()}@flakey.test`;
  assert.equal((await register(known, "knownpass123")).status, 201);

  await clearMailbox();
  const unknown = `ghost+${Date.now()}@nowhere.invalid`;

  // Fire the unknown-email request first, then a known-email request as a
  // sentinel. Both return an identical 200 (the status-level check lives in
  // auth_flow.smoke.test.ts) — here we assert the *delivery* differs: once
  // the known reset mail lands, the SMTP pipeline has processed both, so the
  // absence of any mail to the unknown address is meaningful, not just an
  // under-short wait.
  assert.equal(
    (await fetch(`${BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: unknown }),
    })).status,
    200,
  );
  assert.equal(
    (await fetch(`${BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: known }),
    })).status,
    200,
  );

  await waitForMail(known, "Reset your password"); // sentinel barrier
  assert.equal((await messagesTo(unknown)).length, 0, "no mail may be sent to an unknown email");
});

// ── Resend verification ──────────────────────────────────────────────────

test("resend-verification delivers a fresh, working verification email to an unverified user", async () => {
  const email = `resend+${Date.now()}@flakey.test`;
  assert.equal((await register(email, "resendpass123")).status, 201);

  // Drain the registration verification mail BEFORE clearing: resend mints a
  // fresh token and overwrites the DB, invalidating the original. If the
  // original mail landed after the clear it would carry a now-dead token and
  // we'd extract the wrong one. Waiting for it first makes the clear total.
  await waitForMail(email, "Verify your email");
  await clearMailbox();
  const resend = await fetch(`${BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(resend.status, 200);

  const mail = await waitForMail(email, "Verify your email");
  const token = tokenFrom(mail.Text, "verify-email");
  const verify = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verify.status, 200, "the re-sent token must verify the account");
});
