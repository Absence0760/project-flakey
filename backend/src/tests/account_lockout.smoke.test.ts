/**
 * Per-account login lockout smoke.
 *
 * The authLimiter rate-limit middleware (index.ts:152) gates auth
 * endpoints per IP, which protects the *system* against a single
 * attacker hammering from one source but does nothing for a
 * single *account* targeted by a distributed brute force that
 * only sends a handful of attempts from each of thousands of IPs.
 *
 * Migration 036 added users.failed_login_attempts + users.locked
 * _until, and /auth/login increments the counter on a wrong
 * password / stamps locked_until once the threshold is crossed /
 * resets both on a successful login. This file pins that
 * contract:
 *
 *   1. After LOGIN_LOCKOUT_THRESHOLD failed logins, the next call
 *      returns 429 with code "ACCOUNT_LOCKED".
 *   2. Once locked, even the correct password returns 429 — the
 *      lockout takes precedence over the credential check so a
 *      compromised password doesn't help the attacker while the
 *      lock is in force.
 *   3. Lockout is per-account: user A's lock does NOT lock user B
 *      on the same workstation / same IP.
 *   4. An unknown email returns 401, NOT 429 — the lockout
 *      response shape must not leak whether a real account is
 *      under attack (enumeration resistance).
 *   5. A successful login resets the counter, so a user who
 *      genuinely mis-typed isn't penalised on the next session.
 *   6. locked_until self-expires: once the timestamp passes, the
 *      account is auto-unlocked without admin intervention.
 *
 * The spawn env sets LOGIN_LOCKOUT_THRESHOLD=3 so the gate trips
 * in 3 failures rather than the production default 5, and sets
 * AUTH_RATE_LIMIT_MAX high enough that the per-IP gate doesn't
 * shadow the per-account behaviour under test.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3985;
const BASE = `http://localhost:${PORT}`;
const THRESHOLD = 3;

let server: ChildProcess;
let dbAdmin: pg.Client;

interface UserCtx {
  email: string;
  password: string;
  userId: number;
}

let user1: UserCtx;
let user2: UserCtx;

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

async function registerUser(label: string): Promise<UserCtx> {
  const email = `lockout+${label}+${Date.now()}@test.local`;
  const password = "testpass123";
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: `Lockout-${label}`,
      org_name: `LockoutOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`register ${label} failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { user: { id: number } };
  return { email, password, userId: data.user.id };
}

async function postLogin(email: string, password: string): Promise<Response> {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "account-lockout-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // The units under test.
      LOGIN_LOCKOUT_THRESHOLD: String(THRESHOLD),
      LOGIN_LOCKOUT_MINUTES: "15",
      // High enough that the per-IP rate-limit gate never shadows
      // the per-account behaviour we're exercising here.
      AUTH_RATE_LIMIT_MAX: "500",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  user1 = await registerUser("one");
  user2 = await registerUser("two");
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── 1. The gate trips at LOGIN_LOCKOUT_THRESHOLD failures ──────────────

test("after LOGIN_LOCKOUT_THRESHOLD wrong-password attempts, the account is locked (429 / ACCOUNT_LOCKED)", async () => {
  // Three failed attempts — each individually a 401 — must trip the
  // gate. The very next attempt (correct OR wrong password) must
  // return 429 with the documented `ACCOUNT_LOCKED` code.
  for (let i = 0; i < THRESHOLD; i++) {
    const res = await postLogin(user1.email, "wrong-password");
    assert.equal(
      res.status,
      401,
      `pre-trip attempt #${i + 1} should be 401 (bad password), not 429 — gate must only fire once threshold is crossed`,
    );
  }

  const locked = await postLogin(user1.email, "still-wrong");
  assert.equal(locked.status, 429, "attempt N+1 after threshold must 429");
  const body = (await locked.json()) as { error: string; code: string };
  assert.equal(body.code, "ACCOUNT_LOCKED", "response must include the ACCOUNT_LOCKED code so the UI can prompt password reset");
});

// ── 2. Even the correct password is blocked while locked ───────────────

test("once locked, the CORRECT password returns 429 — lockout overrides the credential check", async () => {
  // user1 is still locked from the previous test. A successful
  // password supply must NOT bypass the lock; the lockout has to
  // run before bcrypt's compare, otherwise an attacker with a
  // freshly-cracked password gets in the moment they find it.
  const res = await postLogin(user1.email, user1.password);
  assert.equal(
    res.status,
    429,
    "lockout must take precedence over credential verification — supplying the right password while locked must still 429",
  );
});

// ── 3. Lockout is scoped per-account ───────────────────────────────────

test("lockout is per-account: a different user's login is unaffected by user1's lock", async () => {
  // user2 has zero failures. The per-account lockout must not
  // contaminate other accounts — that would let one user trivially
  // DoS another by spamming bad logins against their email.
  const res = await postLogin(user2.email, user2.password);
  assert.equal(
    res.status,
    200,
    "user2 must be able to log in while user1 is locked — lockout state is per-row, not global",
  );
});

// ── 4. Unknown emails never expose the lockout shape ───────────────────

test("unknown email returns 401, NOT 429 — lockout shape must not leak account existence", async () => {
  // The 401-for-unknown-email branch is what makes /auth/login
  // resistant to enumeration. The lockout 429 must NOT fire on
  // unknown emails, otherwise an attacker can tell apart
  // "wrong-password on a real account that I've now locked" vs.
  // "unknown email" purely from the response code.
  const res = await postLogin(`definitely-not-a-user-${Date.now()}@test.local`, "anything");
  assert.equal(res.status, 401, "unknown emails must continue to 401 indistinguishably from wrong-password");
});

// ── 5. Successful login clears the counter ─────────────────────────────

test("successful login clears failed_login_attempts and locked_until on a previously-locked account", async () => {
  // Force user1 to unlocked-but-counted state: clear locked_until
  // (so the route lets the request through to credential check)
  // but leave failed_login_attempts at the threshold value. A
  // legitimate password must succeed AND reset both fields.
  await dbAdmin.query(
    "UPDATE users SET locked_until = NULL, failed_login_attempts = $1 WHERE id = $2",
    [THRESHOLD, user1.userId],
  );

  const ok = await postLogin(user1.email, user1.password);
  assert.equal(ok.status, 200, "correct password after lock-clear must succeed");

  const row = await dbAdmin.query(
    "SELECT failed_login_attempts, locked_until FROM users WHERE id = $1",
    [user1.userId],
  );
  assert.equal(
    row.rows[0].failed_login_attempts,
    0,
    "failed_login_attempts must be reset to 0 on a successful login",
  );
  assert.equal(row.rows[0].locked_until, null, "locked_until must be NULLed on a successful login");
});

// ── 6. locked_until self-expiry ────────────────────────────────────────

test("locked_until self-expires: once the timestamp is in the past, login is allowed again", async () => {
  // Force user2 into a state where it appears the account WAS
  // locked but the lock window has passed. The route's
  // `locked_until > NOW()` check must let the request through,
  // otherwise we'd have to ship an admin tool to unlock accounts.
  await dbAdmin.query(
    "UPDATE users SET failed_login_attempts = $1, locked_until = NOW() - INTERVAL '1 second' WHERE id = $2",
    [THRESHOLD + 2, user2.userId],
  );

  const ok = await postLogin(user2.email, user2.password);
  assert.equal(
    ok.status,
    200,
    "expired locked_until must auto-unlock the account; the route's `locked_until > NOW()` check must be active",
  );
});
