/**
 * Connectivity-probe smoke tests, end-to-end.
 *
 * Protects the admin "Test connection" buttons in integration settings:
 * the three `POST /connectivity/{database,email,git}` probes an owner/admin
 * fires from the settings UI. Other files only prove these don't crash
 * (routes_integrations.smoke.test.ts) or that a viewer is 403'd
 * (permissions.smoke.test.ts). This file asserts the *real* success/failure
 * shapes against a live local stack:
 *
 *   - /database: real Postgres is up → ok:true with latency_ms/version/
 *     database/user/size_mb populated and correctly typed.
 *   - /email: Mailpit is up → ok:true, sent_to = the logged-in user's email,
 *     AND the verification message actually lands in Mailpit (the route
 *     awaits the send, so ok:true is a real "SMTP accepted it" — we still
 *     confirm delivery via the Mailpit API, mirroring email.smoke.test.ts).
 *   - /git: a freshly-registered org configures no git provider, so we assert
 *     only the deterministic, offline branch: ok:false +
 *     "Git provider not configured". The happy path requires a live GitHub/
 *     GitLab/Bitbucket API call, which is out of scope for a local-first
 *     offline smoke test — see the note on that test below.
 *
 * Prereqs (same as the other smoke tests): `pnpm db:up` (Postgres + Mailpit)
 * and a seeded DB. The backend points at Mailpit via SMTP_HOST/SMTP_PORT
 * (localhost:1025); override MAILPIT_URL if the web API isn't on :8025.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3955;
const BASE = `http://localhost:${PORT}`;
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

let server: ChildProcess;
let token: string;
let userEmail: string;

interface MailpitSummary {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
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
  // Poll rather than one-shot: the Mailpit container may still be coming up.
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
      `or set MAILPIT_URL. The email probe asserts real delivery, so it cannot run without it.`,
  );
}

/** List every message currently addressed to `to` (lower-cased compare). */
async function messagesTo(to: string): Promise<MailpitSummary[]> {
  const { messages } = await mailpit<{ messages: MailpitSummary[] }>("/api/v1/messages?limit=200");
  const needle = to.toLowerCase();
  return messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === needle));
}

/**
 * Poll until a "Verify your email" message to `to` lands. Polling — not a
 * fixed sleep — because Mailpit indexes the SMTP delivery a beat after the
 * route returns; we wait on the real signal (the message appearing).
 */
async function waitForVerifyMail(to: string, maxMs = 8000): Promise<MailpitSummary> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const hits = (await messagesTo(to)).filter((m) => m.Subject.includes("Verify your email"));
    if (hits.length > 0) return hits[0];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No "Verify your email" message to ${to} arrived within ${maxMs}ms`);
}

function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
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
      JWT_SECRET: "connectivity-smoke-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Point the mailer at Mailpit (defaults already match; set explicitly).
      SMTP_HOST: process.env.SMTP_HOST ?? "localhost",
      SMTP_PORT: process.env.SMTP_PORT ?? "1025",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register a fresh org. The registrant becomes the org `owner`, which passes
  // the connectivity router's admin/owner gate — and the new org has NO git
  // provider configured, which is exactly what the /git test relies on.
  userEmail = `connectivity+${Date.now()}@flakey.test`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: userEmail,
      password: "testpass123",
      name: "Connectivity",
      org_name: `ConnectivityOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  token = ((await reg.json()) as { token: string }).token;

  // Registration sends its own "Verify your email" mail to userEmail. Drain it
  // here by waiting on the real delivery signal, so the /email probe test below
  // can count the message IT sends deterministically. Without this, the
  // registration mail races the probe's mail under concurrent load (other smoke
  // files hammering the shared Mailpit) and the +1 sanity check flakes.
  await waitForVerifyMail(userEmail);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── /connectivity/database ────────────────────────────────────────────────

test("POST /connectivity/database reports a live connection with full diagnostics", async () => {
  const res = await post("/connectivity/database", {});
  assert.equal(res.status, 200, "probe returns 200 even on failure; here it should succeed");
  const data = (await res.json()) as {
    ok: boolean;
    latency_ms: number;
    version: string;
    database: string;
    user: string;
    size_mb: number;
  };

  assert.equal(data.ok, true, "real Postgres is up, so the probe must report ok:true");
  // latency_ms is Date.now() delta — a non-negative integer.
  assert.equal(typeof data.latency_ms, "number");
  assert.ok(Number.isInteger(data.latency_ms) && data.latency_ms >= 0, "latency_ms must be a non-negative integer");
  // version is `version()` truncated to its first two words, e.g. "PostgreSQL 17.x".
  assert.match(data.version, /^PostgreSQL\s+\S+/, "version should start with the PostgreSQL banner");
  // The backend connects to the configured DB as the non-superuser app role.
  assert.equal(data.database, process.env.DB_NAME ?? "flakey", "database must be the configured DB name");
  assert.equal(data.user, process.env.DB_USER ?? "flakey_app", "user must be the non-superuser app role (RLS applies)");
  // size_mb is pg_database_size rounded to whole MB — non-negative integer.
  assert.equal(typeof data.size_mb, "number");
  assert.ok(Number.isInteger(data.size_mb) && data.size_mb >= 0, "size_mb must be a non-negative integer");
});

// ── /connectivity/email ───────────────────────────────────────────────────

test("POST /connectivity/email sends a test mail to the logged-in user and it lands in Mailpit", async () => {
  // Clear only the messages for THIS unique address (other agents share the
  // Mailpit sink) — a DELETE-all would clobber their in-flight mail. We filter
  // by address everywhere, and the unique per-run email keeps us isolated.
  const before = (await messagesTo(userEmail)).length;

  const res = await post("/connectivity/email", {});
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; sent_to?: string; error?: string };

  // The route awaits the send before responding, so ok:true is a real
  // "SMTP accepted the message", not fire-and-forget.
  assert.equal(data.ok, true, `email probe should succeed against Mailpit; got error: ${data.error}`);
  assert.equal(data.sent_to, userEmail, "sent_to must be the logged-in user's email");

  // Confirm the message actually reached the sink, addressed to the user.
  const mail = await waitForVerifyMail(userEmail);
  assert.equal(mail.To[0].Address.toLowerCase(), userEmail.toLowerCase(), "delivered mail must be addressed to the user");
  assert.ok(mail.Subject.includes("Verify your email"), "test mail reuses the verification template");

  // Sanity: the probe adds exactly one new message. The registration mail was
  // already drained in before(), so this delta is solely the probe's send. Poll
  // (don't sample once) — Mailpit indexes the delivery a beat after the route
  // returns, so we wait on the real signal (the new message appearing).
  let after = before;
  const deadline = Date.now() + 8000;
  while (after <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    after = (await messagesTo(userEmail)).length;
  }
  assert.equal(after, before + 1, "the probe should send exactly one new message");
});

// ── /connectivity/git ─────────────────────────────────────────────────────

test("POST /connectivity/git reports not-configured for an org with no git provider", async () => {
  // The freshly-registered org set no git_provider/git_token/git_repo, so the
  // route short-circuits before any network call — the deterministic, offline
  // branch. (The happy path requires a live GitHub/GitLab/Bitbucket API call,
  // which a local-first offline smoke test must not make; it is intentionally
  // not covered here.)
  const res = await post("/connectivity/git", {});
  assert.equal(res.status, 200, "probe returns 200 with ok:false in the body, not an HTTP error");
  const data = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(data.ok, false, "no git provider configured → ok:false");
  assert.equal(data.error, "Git provider not configured", "must surface the documented not-configured message");
});
