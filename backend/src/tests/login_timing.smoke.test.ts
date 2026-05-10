/**
 * Login timing-side-channel smoke.
 *
 * /auth/login was originally returning on an unknown email BEFORE
 * running bcrypt; a known-email wrong-password branch took the
 * full bcrypt cost (~200 ms at cost factor 12). The 100x response-
 * time difference let an attacker enumerate valid emails purely
 * from wall-clock timing — no content, no status code change
 * required, just `curl -w '%{time_total}'`.
 *
 * The fix runs bcrypt.compareSync against a precomputed dummy
 * hash on the unknown-email branch (routes/auth.ts:DUMMY_BCRYPT
 * _HASH) so both branches incur the same bcrypt-bounded cost.
 *
 * The test takes 5 samples each of the unknown-email and wrong-
 * password paths and asserts the MEDIAN response time for the
 * unknown-email path is bcrypt-bounded (> 50 ms).  Median guards
 * against the occasional GC-pause outlier; 50 ms is generous —
 * an early-return path completes in single-digit ms.
 *
 * Note this is a behavioural test, not an exact-timing one. It
 * will pass on any CPU where bcrypt at cost 12 takes more than
 * ~50 ms — i.e. every machine where the cost factor is doing
 * anything useful for password hashing.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3982;
const BASE = `http://localhost:${PORT}`;
const SAMPLES = 5;

let server: ChildProcess;
let knownEmail: string;

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

async function timeRequest(email: string, password: string): Promise<number> {
  const start = process.hrtime.bigint();
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  // Drain the body so the measurement covers the full response cycle.
  await res.text();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "login-timing-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // High enough that the per-IP gate never trips during the
      // 5+5 samples we run — we want every request to actually
      // exercise the credential-check path, not 429 early.
      AUTH_RATE_LIMIT_MAX: "500",
      // Disable per-account lockout for this test (THRESHOLD beyond
      // the sample count) so the wrong-password branch isn't
      // shadowed by an early 429 once the counter trips.
      LOGIN_LOCKOUT_THRESHOLD: "100",
      LOGIN_LOCKOUT_MINUTES: "1",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register one user so we have a real account to throw the
  // wrong-password samples at.
  knownEmail = `timing-known+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: knownEmail,
      password: "testpass123",
      name: "Timing",
      org_name: `TimingOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("/auth/login response time on unknown emails is bcrypt-bounded (no early-return timing leak)", async () => {
  // Warm the route once so we don't measure the first-hit JIT cost.
  await timeRequest(`warmup+${Date.now()}@test.local`, "any");

  const unknownTimings: number[] = [];
  const wrongPasswordTimings: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    unknownTimings.push(await timeRequest(`nobody+${Date.now()}+${i}@test.local`, "anything"));
    wrongPasswordTimings.push(await timeRequest(knownEmail, "deliberately-wrong"));
  }

  const unknownMedian = median(unknownTimings);
  const wrongMedian = median(wrongPasswordTimings);

  // 50 ms is the discriminator. An early-return unknown-email
  // path completes in single-digit ms; a bcrypt-bounded one
  // takes 100-300 ms on commodity hardware at cost factor 12.
  // 50 ms is comfortably above the no-bcrypt path and well below
  // the bcrypt path, leaving plenty of slack for slow CI VMs.
  assert.ok(
    unknownMedian > 50,
    `unknown-email median response time was ${unknownMedian.toFixed(1)}ms — must be > 50ms to prove bcrypt is being run, otherwise an attacker can enumerate valid emails by timing alone (wrong-password median was ${wrongMedian.toFixed(1)}ms)`,
  );

  // Sanity-check the wrong-password timing too, so a regression
  // that accidentally short-circuits bcrypt entirely (e.g. a
  // mocked bcrypt in test) gets caught.
  assert.ok(
    wrongMedian > 50,
    `wrong-password median was ${wrongMedian.toFixed(1)}ms — must be > 50ms; if this drops below, bcrypt likely isn't running and the wrong-password check is degenerate`,
  );
});
