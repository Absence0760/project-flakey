/**
 * DB-backed stale-live-run reconciler (reconcileStaleLiveRuns).
 *
 * A live run is "active" purely by DB state — finished_at IS NULL and no
 * persisted run.aborted event (activeRunIdsForOrg). The in-memory stale sweeper
 * (getStaleRuns) only sees runs tracked on the current task's bus, so it can't
 * rescue runs orphaned by a backend restart, or by a reporter that emitted
 * run.finished but whose end-of-run upload never landed. Such runs stay
 * finished_at IS NULL forever and render LIVE indefinitely.
 *
 * reconcileStaleLiveRuns closes that gap from the DB. This spec proves:
 *   1. Every /events POST (incl. an empty-body heartbeat) advances
 *      runs.last_event_at — the liveness signal the reconciler reads.
 *   2. A run quiet past the stale window is aborted: a run.aborted event is
 *      persisted and its pending tests transition to skipped.
 *   3. A run with a recent heartbeat (fresh last_event_at) is NOT aborted —
 *      the heartbeat-respecting guarantee, so a quiet-but-alive run survives.
 *   4. A finished run is never touched, and a second reconcile pass is a no-op
 *      (abortRun is idempotent — no duplicate run.aborted).
 *
 * Spawns a server for the real /live HTTP surface and calls the reconciler
 * in-process (it has no endpoint) with a short stale window. Needs the local
 * DB (db.js defaults to flakey_app/flakey).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import pool, { tenantQuery } from "../db.js";

const PORT = 3971;
const BASE = `http://localhost:${PORT}`;
// Generous server-side stale window so the spawned server's OWN sweeper /
// boot reconcile never aborts our runs mid-assertion — we drive reconciliation
// explicitly from the test process instead.
const SERVER_TIMEOUT_MS = "600000";

let server: ChildProcess;
let token: string;
let orgId: number;
let reconcileStaleLiveRuns: (orgIds?: number[]) => Promise<number>;

function spawnServer(): ChildProcess {
  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "stale-reconcile-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: SERVER_TIMEOUT_MS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return proc;
}

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function startRun(ciRunId: string): Promise<number> {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite: "stale-reconcile-e2e", ciRunId }),
  });
  assert.ok(res.ok, `/live/start failed: ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

async function postEvent(runId: number, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}/live/${runId}/events`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  assert.ok(res.ok, `/events failed: ${res.status}`);
}

async function lastEventAt(runId: number): Promise<Date> {
  const r = await tenantQuery(orgId, "SELECT last_event_at FROM runs WHERE id = $1", [runId]);
  return new Date(r.rows[0].last_event_at as string);
}

async function abortedEventCount(runId: number): Promise<number> {
  const r = await tenantQuery(orgId,
    "SELECT count(*)::int AS n FROM live_events WHERE run_id = $1 AND event_type = 'run.aborted'",
    [runId]);
  return r.rows[0].n as number;
}

/**
 * Wait until the run has `count` test rows. /events returns 200 before its
 * post-response DB writes commit, and the spawned server processes them on a
 * different process's per-run chain than this test's in-process reconciler — so
 * we wait on the real signal (the row landing) rather than racing it. (In prod
 * the reconciler shares the process + chain with /events, so this race is a
 * test-only artifact of the two-process setup.)
 */
async function waitForTestRows(runId: number, count: number, maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await tenantQuery(orgId,
      "SELECT count(*)::int AS n FROM tests t JOIN specs s ON s.id = t.spec_id WHERE s.run_id = $1", [runId]);
    if ((r.rows[0].n as number) >= count) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} did not reach ${count} test row(s) in time`);
}

/** Backdate last_event_at so the run reads as quiet past the stale window. */
async function makeStale(runId: number): Promise<void> {
  await tenantQuery(orgId,
    "UPDATE runs SET last_event_at = NOW() - INTERVAL '5 seconds' WHERE id = $1", [runId]);
}

before(async () => {
  // The in-process reconciler reads STALE_INACTIVITY_MS from this env at module
  // load, so set it (short) BEFORE the dynamic import.
  process.env.FLAKEY_LIVE_TIMEOUT_MS = "1000";
  ({ reconcileStaleLiveRuns } = await import("../routes/live.js"));

  server = spawnServer();
  await waitForHealth();

  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `stale-reconcile+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Stale-Reconcile",
    }),
  });
  assert.ok(res.ok, `register failed: ${res.status}`);
  token = ((await res.json()) as { token: string }).token;
  // register mints a personal org; its id rides in the JWT (requireAuth reads
  // req.user.orgId), so decode it rather than guessing the generated org name.
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { orgId: number };
  orgId = payload.orgId;
  assert.ok(Number.isInteger(orgId), "token must carry a numeric orgId");
});

after(async () => {
  server?.kill("SIGKILL");
  await pool.end().catch(() => {});
});

test("every /events POST — including an empty heartbeat — advances last_event_at", async () => {
  const runId = await startRun("hb-1");
  const t0 = await lastEventAt(runId);
  await new Promise((r) => setTimeout(r, 30));
  // Empty-array heartbeat: carries no test events but must still bump liveness.
  await postEvent(runId, []);
  const t1 = await lastEventAt(runId);
  assert.ok(t1.getTime() > t0.getTime(), "heartbeat must advance last_event_at");
});

test("a run quiet past the stale window is aborted and its pending tests skipped", async () => {
  const runId = await startRun("stale-1");
  await postEvent(runId, { type: "test.started", spec: "spec/a.cy.ts", test: "does a thing" });
  // The test.started event creates a pending row (await it landing first).
  await waitForTestRows(runId, 1);
  const before = await tenantQuery(orgId,
    "SELECT t.status FROM tests t JOIN specs s ON s.id = t.spec_id WHERE s.run_id = $1", [runId]);
  assert.equal(before.rows[0].status, "pending");

  await makeStale(runId);
  const aborted = await reconcileStaleLiveRuns([orgId]);
  assert.ok(aborted >= 1, "reconciler should report at least one aborted run");

  assert.equal(await abortedEventCount(runId), 1, "a run.aborted event must be persisted");
  const afterRows = await tenantQuery(orgId,
    "SELECT t.status FROM tests t JOIN specs s ON s.id = t.spec_id WHERE s.run_id = $1", [runId]);
  assert.equal(afterRows.rows[0].status, "skipped", "pending test must transition to skipped");
});

test("a run with a recent heartbeat is NOT aborted (heartbeat-respecting)", async () => {
  const runId = await startRun("fresh-1");
  await postEvent(runId, []); // recent heartbeat → last_event_at = now
  await reconcileStaleLiveRuns([orgId]);
  assert.equal(await abortedEventCount(runId), 0, "a fresh run must survive reconciliation");
});

test("a finished run is untouched, and a second reconcile pass is a no-op (idempotent)", async () => {
  const runId = await startRun("finished-1");
  // Simulate the authoritative end-of-run finish, then go quiet.
  await tenantQuery(orgId, "UPDATE runs SET finished_at = NOW() WHERE id = $1", [runId]);
  await makeStale(runId);
  await reconcileStaleLiveRuns([orgId]);
  assert.equal(await abortedEventCount(runId), 0, "a finished run must never be aborted");

  // Re-abort safety: a stale run aborted once stays at exactly one run.aborted.
  const staleId = await startRun("idempotent-1");
  await makeStale(staleId);
  await reconcileStaleLiveRuns([orgId]);
  await makeStale(staleId); // backdate again so it would re-qualify if the query missed the abort
  await reconcileStaleLiveRuns([orgId]);
  assert.equal(await abortedEventCount(staleId), 1, "abortRun must be idempotent — no duplicate run.aborted");
});
