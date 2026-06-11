/**
 * Registration email-verification *gate* smoke test.
 *
 * With REQUIRE_EMAIL_VERIFICATION=true, POST /auth/register must withhold the
 * session entirely — no JWT, no refresh token, no auth cookie — so a brand-new
 * unverified account cannot use the app until the emailed link flips
 * email_verified. (The earlier behaviour minted a live session at registration
 * regardless, which let an unverified registrant use the app for the token's
 * full lifetime; verification only re-gated the *next* login.)
 *
 * This drives the full lifecycle through the real Mailpit sink:
 *   register → 201 with NO token / NO Set-Cookie, emailVerificationRequired=true
 *   login (pre-verify) → 403 EMAIL_NOT_VERIFIED
 *   click the emailed link (verify-email) → 200
 *   login (post-verify) → 200 with a real token
 *
 * Prereqs (same as email.smoke.test.ts): `pnpm db:up` (Postgres + Mailpit) and
 * a seeded DB. Override MAILPIT_URL if the web API isn't on the default :8025.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3969;
const BASE = `http://localhost:${PORT}`;
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
const FROM_ADDRESS = "ci-noreply@flakey.test";
const FRONTEND_URL = "http://localhost:7778";

let server: ChildProcess;

interface MailpitSummary {
  ID: string;
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
}
interface MailpitMessage extends MailpitSummary {
  Text: string;
  HTML: string;
}

async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MAILPIT}${path}`, init);
  if (!res.ok) throw new Error(`Mailpit ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function assertMailpitReachable(maxMs = 15000): Promise<void> {
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
    `Mailpit not reachable at ${MAILPIT}. Run \`pnpm db:up\` (it starts Mailpit) or set MAILPIT_URL.`,
  );
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

async function waitForMail(to: string, subjectIncludes: string, maxMs = 8000): Promise<MailpitMessage> {
  const needle = to.toLowerCase();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { messages } = await mailpit<{ messages: MailpitSummary[] }>("/api/v1/messages?limit=200");
    const hit = messages.find(
      (m) => m.Subject.includes(subjectIncludes) && m.To.some((t) => t.Address.toLowerCase() === needle),
    );
    if (hit) return mailpit<MailpitMessage>(`/api/v1/message/${hit.ID}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No "${subjectIncludes}" email to ${to} arrived within ${maxMs}ms`);
}

const tokenFrom = (body: string, path: string): string => {
  const m = body.match(new RegExp(`${path}\\/([a-f0-9]{64})`));
  if (!m) throw new Error(`no ${path} token in email body:\n${body}`);
  return m[1];
};

async function register(email: string, password: string): Promise<Response> {
  return fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Gate Tester", org_name: `GateOrg-${email}` }),
  });
}

async function login(email: string, password: string): Promise<Response> {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  await assertMailpitReachable();
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "register-gate-smoke-secret",
      ALLOW_REGISTRATION: "true",
      REQUIRE_EMAIL_VERIFICATION: "true",
      NODE_ENV: "test",
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

test("with verification required, register withholds the session and login is gated until verified", async () => {
  const email = `gate+${Date.now()}@flakey.test`;
  const password = "gateme123";

  // 1. Register: 201, but NO session is handed out.
  const reg = await register(email, password);
  assert.equal(reg.status, 201, "registration should succeed");

  const body = (await reg.json()) as {
    token?: string;
    refreshToken?: string;
    emailVerificationRequired?: boolean;
    user?: { email: string };
  };
  assert.equal(body.emailVerificationRequired, true, "response must flag that verification is required");
  assert.equal(body.token, undefined, "no access token may be minted before verification");
  assert.equal(body.refreshToken, undefined, "no refresh token may be minted before verification");
  assert.equal(body.user?.email?.toLowerCase(), email.toLowerCase(), "the created user is still returned");

  // ...and crucially no auth cookie is set, or the SPA would be silently signed in.
  const setCookie = reg.headers.get("set-cookie") ?? "";
  assert.ok(!/flakey_token=/.test(setCookie), "no flakey_token cookie may be set before verification");
  assert.ok(!/flakey_refresh=/.test(setCookie), "no flakey_refresh cookie may be set before verification");

  // 2. Login before verifying is rejected with the dedicated code.
  const preLogin = await login(email, password);
  assert.equal(preLogin.status, 403, "login before verification must be rejected");
  const preBody = (await preLogin.json()) as { code?: string };
  assert.equal(preBody.code, "EMAIL_NOT_VERIFIED", "rejection must carry the EMAIL_NOT_VERIFIED code");

  // 3. Click the emailed verification link.
  const mail = await waitForMail(email, "Verify your email");
  const token = tokenFrom(mail.Text, "verify-email");
  const verify = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verify.status, 200, "emailed verification token must be accepted");

  // 4. Now login works and actually mints a session.
  const postLogin = await login(email, password);
  assert.equal(postLogin.status, 200, "login after verification must succeed");
  const postBody = (await postLogin.json()) as { token?: string };
  assert.ok(postBody.token, "a real access token is minted only after verification");
});
