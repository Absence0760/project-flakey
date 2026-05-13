/**
 * Auth-endpoint rate limiting smoke.
 *
 * index.ts:152 wires a single `authLimiter` rate-limit instance to
 * /auth/login, /auth/register, /auth/forgot-password,
 * /auth/reset-password, /auth/resend-verification. Limit is
 * AUTH_RATE_LIMIT_MAX per 15-minute window per IP (default 20 in
 * prod, 500 in dev, env-overridable). The gate is the only thing
 * stopping IP-level brute-force on /auth/login.
 *
 * What's pinned here:
 *   1. Attempt N+1 from the same IP after the limit returns 429
 *      with the documented "Try again in 15 minutes." message —
 *      not 401, not 200, not 500.
 *   2. The limiter bucket is shared across ALL gated routes per IP.
 *      Once /auth/login burns the budget, /auth/register from the
 *      same IP also 429s. A regression that splits the bucket would
 *      let an attacker rotate routes to bypass the limit.
 *   3. Standard RateLimit-* response headers accompany the 429 so
 *      compliant clients can back off (standardHeaders: true in the
 *      limiter config).
 *
 * The tests run sequentially in registration order, and each
 * builds on the gated state of the previous one (the in-memory
 * bucket persists for the spawned server's lifetime). The spawn
 * env sets AUTH_RATE_LIMIT_MAX=3 so the limit trips after a handful
 * of attempts, not the full 500-attempt dev default.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3986;
const BASE = `http://localhost:${PORT}`;
const LIMIT = 3;

let server: ChildProcess;
let seededEmail: string;

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

async function postLogin(email: string, password: string): Promise<Response> {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function postRegister(email: string): Promise<Response> {
  return fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "Rate Limited",
      org_name: `RateLimitedOrg-${Date.now()}`,
    }),
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
      JWT_SECRET: "rate-limit-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // The unit under test.
      AUTH_RATE_LIMIT_MAX: String(LIMIT),
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Seed a real user so the first LIMIT logins fail with 401
  // (wrong password) — not 429 — and we can isolate the gate trip
  // on attempt LIMIT+1.
  seededEmail = `rate-limit-seed+${Date.now()}@test.local`;
  const reg = await postRegister(seededEmail);
  if (!reg.ok) throw new Error(`seed registration failed: ${reg.status}`);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── 1. Limit gate trips on attempt N+1 ─────────────────────────────────

test("after AUTH_RATE_LIMIT_MAX failed logins, attempt N+1 returns 429 with the documented message", async () => {
  // Note: the seed registration above counted as 1 attempt against
  // the bucket (registration is gated by the same limiter). So
  // attempt LIMIT - 1 here is what pushes us to the cap. The test
  // tolerates either ordering by exhausting the bucket then
  // asserting the next call is 429.
  for (let i = 0; i < LIMIT * 2; i++) {
    const res = await postLogin(seededEmail, "wrong-password");
    if (res.status === 429) {
      const body = (await res.json()) as { error: string };
      assert.match(
        body.error,
        /Too many attempts/i,
        "429 body must carry the documented 'Too many attempts' message so clients/users see the right hint",
      );
      return; // PASS — gate tripped within the loop's budget.
    }
    // Non-429 must be a clean 4xx (typically 401 for wrong password).
    assert.ok(
      res.status >= 400 && res.status < 500,
      `pre-trip attempt should 4xx; got ${res.status}`,
    );
  }
  assert.fail(`auth limiter did not trip within ${LIMIT * 2} login attempts (AUTH_RATE_LIMIT_MAX=${LIMIT})`);
});

// ── 2. Cross-endpoint coverage — the bucket is shared per IP ───────────

test("once tripped, /auth/register from the same IP also 429s (the limiter is cross-endpoint)", async () => {
  // The previous test exhausted the bucket via /auth/login. The
  // same per-IP bucket gates /auth/register, so a fresh
  // registration attempt from this test process must also 429.
  // A regression that gave each route its own bucket would let an
  // attacker rotate routes to side-step the limit.
  const res = await postRegister(`rl-rotate+${Date.now()}@test.local`);
  assert.equal(
    res.status,
    429,
    "an attacker rotating from /auth/login to /auth/register from the same IP must NOT escape the gate",
  );
});

test("once tripped, /auth/forgot-password from the same IP also 429s", async () => {
  // /auth/forgot-password normally returns 200 even for unknown
  // emails (enumeration resistance). The limiter sits in front of
  // the route handler though, so a 429 from a tripped bucket
  // pre-empts the 200 — exactly what we want, otherwise an
  // attacker could spray forgot-password to keep refreshing reset
  // tokens at no cost.
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "anyone@example.com" }),
  });
  assert.equal(
    res.status,
    429,
    "/auth/forgot-password's enumeration-resistant 200 must NOT shadow the rate-limit 429",
  );
});

test("once tripped, /auth/refresh from the same IP also 429s (refresh-token brute force gate)", async () => {
  // /auth/refresh accepts a refresh token in the body and trades
  // it for a new access token. Without this gate, an attacker
  // who scraped one expired refresh token could spray it against
  // the rotation endpoint trying to land between revocations.
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: "fake-refresh-token-for-rate-limit-test" }),
  });
  assert.equal(
    res.status,
    429,
    "/auth/refresh must be gated by authLimiter or attackers can spray refresh tokens",
  );
});

test("once tripped, /auth/logout from the same IP also 429s (no-cost spam gate)", async () => {
  // /auth/logout is also rate-limited so a tripped bucket
  // shows up here too. Less security-critical than refresh,
  // but the gate must remain wired.
  const res = await fetch(`${BASE}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: "anything" }),
  });
  assert.equal(
    res.status,
    429,
    "/auth/logout must be gated by authLimiter (cross-endpoint bucket sharing)",
  );
});

// ── 3. Standard RateLimit-* headers accompany the 429 ──────────────────

test("rate-limited 429 response carries the standard RateLimit-* headers so clients can back off", async () => {
  const res = await postLogin(seededEmail, "wrong-password");
  assert.equal(res.status, 429);
  // standardHeaders: true is set on the limiter (index.ts:158);
  // it produces RateLimit-Limit, RateLimit-Remaining, and
  // RateLimit-Reset (per the IETF draft).
  const limit = res.headers.get("ratelimit-limit");
  const remaining = res.headers.get("ratelimit-remaining");
  const reset = res.headers.get("ratelimit-reset");
  assert.ok(limit, "RateLimit-Limit header must be present on rate-limit responses");
  assert.ok(remaining !== null, "RateLimit-Remaining must be present (even '0' counts)");
  assert.ok(reset, "RateLimit-Reset must be present so clients know when to retry");
  assert.equal(Number(limit), LIMIT, "RateLimit-Limit must reflect the configured AUTH_RATE_LIMIT_MAX");
});
