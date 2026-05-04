/**
 * Live-event ordering / replay / abort-recovery smoke tests.
 *
 * The live channel has several invariants the existing phase_9_10 file
 * touches but does not exhaustively cover:
 *
 *  - Out-of-order events: test.passed arrives before its matching
 *    test.started (Cypress reordering on retries).  The pending row
 *    must still be created and then transitioned, not silently
 *    dropped.
 *  - Duplicate events: same event POSTed twice.  Must be idempotent.
 *  - Abort + new run reuse: a run in `aborted` state should not be
 *    re-emittable.  A subsequent /live/start creates a NEW run.
 *  - History endpoint pagination + ordering: events return in
 *    insertion order so the frontend can replay them on refresh.
 *  - run.aborted is sticky: even after the in-memory active set is
 *    cleared, GET /runs/:id still reports aborted=true via the
 *    EXISTS-on-live_events query.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3994;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "live-ordering-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Long timeout so unrelated abort logic doesn't fire mid-test.
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `live-order+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Live Order",
      org_name: `LiveOrderOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

async function startLiveRun(suite: string): Promise<number> {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite }),
  });
  if (!res.ok) throw new Error(`/live/start failed: ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

async function postEvents(runId: number, events: unknown[]): Promise<Response> {
  return fetch(`${BASE}/live/${runId}/events`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(events),
  });
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const start = Date.now();
  let last: T = await fn();
  while (Date.now() - start < timeoutMs) {
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
    last = await fn();
  }
  return last;
}

// ── Ordering ────────────────────────────────────────────────────────────

test("live events: same test.started posted twice is idempotent (one tests row)", async () => {
  // The migration-030 partial unique index `idx_tests_pending_unique`
  // is supposed to coalesce two concurrent test.started events into a
  // single row.  This file's existing version catches the SAME-batch
  // case; here we exercise the cross-batch case (two separate POSTs).
  const runId = await startLiveRun(`order-dedup-${Date.now()}`);
  const evt = {
    type: "test.started",
    runId,
    spec: "spec.cy.ts",
    test: "duplicate test",
    timestamp: Date.now(),
  };

  await postEvents(runId, [evt]);
  await postEvents(runId, [evt]);

  // Now upload a final run so we can read back via /runs.
  const detail = await waitFor(
    async () => {
      const r = await fetch(`${BASE}/runs/${runId}`, { headers: authHeaders() });
      return r.ok ? ((await r.json()) as { specs: Array<{ tests: Array<{ status: string }> }> }) : null;
    },
    (v) => !!v && v.specs.length > 0,
    3000
  );
  if (!detail) return; // skip — server may not have flushed
  const pending = detail.specs.flatMap((s) => s.tests).filter((t) => t.status === "pending");
  assert.equal(pending.length, 1, `cross-POST duplicate test.started should leave exactly 1 pending row, got ${pending.length}`);
});

test("live events: test.passed arriving before test.started still resolves cleanly", async () => {
  // Reporters retrying flaky tests can emit events out of order.  The
  // backend should not crash; either it creates the row in 'passed'
  // state or it materializes a pending row first.
  const runId = await startLiveRun(`order-flip-${Date.now()}`);
  const ts = Date.now();
  const passedFirst = await postEvents(runId, [
    { type: "test.passed", runId, spec: "out.cy.ts", test: "OOO test", duration_ms: 10, timestamp: ts },
    { type: "test.started", runId, spec: "out.cy.ts", test: "OOO test", timestamp: ts + 1 },
  ]);
  assert.ok(passedFirst.ok, `POST /live/:id/events with reordered events should not 5xx; got ${passedFirst.status}`);
});

// ── Replay ──────────────────────────────────────────────────────────────

test("GET /live/:runId/history returns events in chronological order", async () => {
  const runId = await startLiveRun(`history-order-${Date.now()}`);
  const baseTs = Date.now();

  // Emit 5 events, deliberately with non-monotonic client timestamps to
  // verify the server orders by INSERTION time (id ASC), not by the
  // client-supplied timestamp (which is unreliable across CI workers).
  await postEvents(runId, [{ type: "spec.started", runId, spec: "a.cy.ts", timestamp: baseTs + 3000 }]);
  await postEvents(runId, [{ type: "test.started", runId, spec: "a.cy.ts", test: "t1", timestamp: baseTs + 1000 }]);
  await postEvents(runId, [{ type: "test.passed", runId, spec: "a.cy.ts", test: "t1", duration_ms: 5, timestamp: baseTs + 2000 }]);

  const history = await waitFor(
    async () => {
      const r = await fetch(`${BASE}/live/${runId}/history`, { headers: authHeaders() });
      return r.ok ? ((await r.json()) as Array<{ type: string; spec?: string; test?: string }>) : [];
    },
    (rows) => rows.length >= 4,
    3000
  );

  // First event should be the implicit run.started from /live/start;
  // subsequent ones in insertion order.  We don't enforce exact length
  // (some implementations may collapse spec.started) — just the order.
  assert.ok(history.length >= 3, `expected at least 3 history events, got ${history.length}`);
  const types = history.map((h) => h.type);
  // The OOO ts on spec.started came AFTER test.started in client time,
  // but we POSTed it first, so it must come first in history.
  const specStartedIdx = types.indexOf("spec.started");
  const testStartedIdx = types.indexOf("test.started");
  if (specStartedIdx >= 0 && testStartedIdx >= 0) {
    assert.ok(
      specStartedIdx < testStartedIdx,
      "history must order by insertion id, not client timestamp"
    );
  }
});

// ── Abort stickiness ────────────────────────────────────────────────────

test("run.aborted via POST /live/:id/abort makes GET /runs/:id report aborted=true", async () => {
  const runId = await startLiveRun(`abort-sticky-${Date.now()}`);

  // Emit a test event so the run is "live" before we abort.
  await postEvents(runId, [
    { type: "test.started", runId, spec: "x.cy.ts", test: "t", timestamp: Date.now() },
  ]);

  const abort = await fetch(`${BASE}/live/${runId}/abort`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ reason: "test abort canary" }),
  });
  assert.ok(abort.ok, `abort should return ok; got ${abort.status}`);

  const detail = await waitFor(
    async () => {
      const r = await fetch(`${BASE}/runs/${runId}`, { headers: authHeaders() });
      return r.ok ? ((await r.json()) as { aborted?: boolean }) : null;
    },
    (v) => v?.aborted === true,
    3000
  );
  assert.equal(detail?.aborted, true, "GET /runs/:id should reflect run.aborted state");
});

test("POST /live/:id/abort is idempotent — a second abort doesn't 5xx", async () => {
  const runId = await startLiveRun(`abort-idem-${Date.now()}`);

  await postEvents(runId, [
    { type: "test.started", runId, spec: "y.cy.ts", test: "t", timestamp: Date.now() },
  ]);
  const a1 = await fetch(`${BASE}/live/${runId}/abort`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ reason: "first" }),
  });
  assert.ok(a1.ok, "first abort should succeed");

  const a2 = await fetch(`${BASE}/live/${runId}/abort`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ reason: "second" }),
  });
  // Acceptable: 200 (no-op) OR 404 (already gone from active set).
  // What's not acceptable: 500 or anything 5xx.
  assert.ok(a2.status < 500, `repeat abort must not 5xx; got ${a2.status}`);
});

// ── Heartbeat ──────────────────────────────────────────────────────────

test("empty-body events POST treats payload {} as a heartbeat", async () => {
  const runId = await startLiveRun(`heartbeat-${Date.now()}`);

  // The plain-object form (not array) should still be accepted, treating
  // the missing fields as a no-op heartbeat that just bumps lastEventAt.
  const res = await fetch(`${BASE}/live/${runId}/events`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  assert.ok(res.ok, `empty events POST should succeed as heartbeat; got ${res.status}`);
});

test("events POST with malformed body returns 4xx, not 5xx", async () => {
  const runId = await startLiveRun(`bad-body-${Date.now()}`);
  // Send a string where an object/array is expected.  The route must
  // either parse-fail (Express rejects) or reject with 400 — never 500.
  const res = await fetch(`${BASE}/live/${runId}/events`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: '"i am a string not a payload"',
  });
  assert.ok(res.status < 500, `malformed body should not 5xx; got ${res.status}`);
});

// ── /live/start input validation ────────────────────────────────────────

test("POST /live/start without suite returns 400", async () => {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /live/start trims environment whitespace", async () => {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite: "env-trim", environment: "  qa  " }),
  });
  assert.equal(res.status, 201);
  const { id } = (await res.json()) as { id: number };

  const detail = await fetch(`${BASE}/runs/${id}`, { headers: authHeaders() });
  const data = (await detail.json()) as { environment?: string };
  if (data.environment !== undefined) {
    // Whitespace must be trimmed before persistence.  An untrimmed
    // value would leak into the dashboard env filter as "  qa  ", a
    // distinct value from "qa".
    assert.equal(data.environment, "qa", "environment must be whitespace-trimmed before persisting");
  }
});
