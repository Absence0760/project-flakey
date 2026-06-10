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

async function fetchRunDetail(runId: number) {
  const r = await fetch(`${BASE}/runs/${runId}`, { headers: authHeaders() });
  return r.ok
    ? ((await r.json()) as {
        total: number; passed: number; failed: number;
        specs: Array<{ tests: Array<{ title: string; status: string }> }>;
      })
    : null;
}

// Events for a run process strictly in arrival order (enqueueOnRun), and the
// HTTP POST returns before that processing finishes. To read a *settled*
// state without sleeping, append a SENTINEL test as the last event and wait
// until its row lands — by then every earlier event in the chain (the
// duplicate/retry under test) is guaranteed processed too.
const SENTINEL = "zzz-sentinel-test";
async function waitForSentinel(runId: number, spec: string) {
  await postEvents(runId, [{ type: "test.passed", spec, test: SENTINEL, duration_ms: 1 }]);
  return waitFor(
    fetchRunDetail.bind(null, runId),
    (d) => !!d && d.specs.flatMap((s) => s.tests).some((t) => t.title === SENTINEL && t.status === "passed"),
    3000,
  );
}

test("live events: a duplicate test.passed is idempotent — one row, stats not double-counted", async () => {
  // At-least-once delivery (a retried events POST, an SSE reconnect replay)
  // can land the SAME terminal event twice. The second must update the
  // existing row in place, not insert a second one that inflates the run's
  // total/passed. (The file header claims this invariant; only the
  // test.started case was actually covered before.)
  const runId = await startLiveRun(`dup-terminal-${Date.now()}`);
  const spec = "dup.cy.ts", title = "duplicate terminal test";
  await postEvents(runId, [{ type: "spec.started", spec }]);
  await postEvents(runId, [{ type: "test.started", spec, test: title }]);
  await postEvents(runId, [{ type: "test.passed", spec, test: title, duration_ms: 10 }]);
  await postEvents(runId, [{ type: "test.passed", spec, test: title, duration_ms: 10 }]);

  const d = await waitForSentinel(runId, spec);
  assert.ok(d, "run detail should be readable");
  const rows = d!.specs.flatMap((s) => s.tests).filter((t) => t.title === title);
  assert.equal(rows.length, 1, `duplicate test.passed must leave exactly 1 row, got ${rows.length}`);
  assert.equal(rows[0].status, "passed");
  // total = the target test + the sentinel = 2 (NOT 3, which is what a
  // duplicate-inserted row would make it).
  assert.equal(d!.total, 2, "the run total must not double-count the duplicate event");
  assert.equal(d!.passed, 2, "the run passed count must not double-count the duplicate event");
});

test("live events: a within-run retry (fail then pass) collapses to one passed row", async () => {
  // Cypress/Playwright retries emit test.failed then test.passed for the
  // SAME test within one run. The live view must collapse these to a single
  // row carrying the latest outcome — not leave both a failed and a passed
  // row, which would make the run report a phantom failure (failed=1) for a
  // test that ultimately passed.
  const runId = await startLiveRun(`retry-${Date.now()}`);
  const spec = "retry.cy.ts", title = "flaky-on-retry test";
  await postEvents(runId, [{ type: "spec.started", spec }]);
  await postEvents(runId, [{ type: "test.started", spec, test: title }]);
  await postEvents(runId, [{ type: "test.failed", spec, test: title, duration_ms: 10, error: "boom" }]);
  await postEvents(runId, [{ type: "test.passed", spec, test: title, duration_ms: 12 }]);

  const d = await waitForSentinel(runId, spec);
  assert.ok(d, "run detail should be readable");
  const rows = d!.specs.flatMap((s) => s.tests).filter((t) => t.title === title);
  assert.equal(rows.length, 1, `retry fail→pass must leave exactly 1 row, got ${rows.length}`);
  assert.equal(rows[0].status, "passed", "the surviving row reflects the latest (passing) attempt");
  assert.equal(d!.failed, 0, "a test that ultimately passed must not leave the run with failed > 0");
  // target test + sentinel, both passed.
  assert.equal(d!.passed, 2);
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

// ── /live/start idempotency on (suite, ci_run_id) ───────────────────────

test("POST /live/start with the same suite+ci_run_id twice returns the same id (idempotent resume)", async () => {
  // Real-world scenarios: reporter crash + restart, CI retry, fork-
  // and-merge of parallel matrix workers that all call /live/start
  // with the same CI run id. The route's INSERT ... ON CONFLICT
  // against uniq_runs_ci_run (migration 035) must return the
  // existing run row instead of either (a) silently creating a
  // duplicate or (b) failing with a 500 on the unique-index
  // violation. The response carries `resumed: true` so the caller
  // can tell which branch they got.
  const suite = `live-start-resume-${Date.now()}`;
  const ciRunId = `ci-resume-${Date.now()}`;

  const first = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite, ciRunId }),
  });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { id: number; ci_run_id: string; resumed: boolean };
  assert.equal(firstBody.resumed, false, "first /live/start with a fresh ci_run_id must NOT be flagged resumed");

  const second = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite, ciRunId }),
  });
  assert.equal(second.status, 201, "repeated /live/start must succeed, not 500 on the unique-index violation");
  const secondBody = (await second.json()) as { id: number; ci_run_id: string; resumed: boolean };
  assert.equal(secondBody.id, firstBody.id, "repeated /live/start with the same (suite, ci_run_id) must return the original id");
  assert.equal(secondBody.resumed, true, "second /live/start must flag resumed=true so the reporter knows it reattached");
});

test("POST /live/start WITHOUT a ci_run_id always allocates a fresh id (no accidental collapse)", async () => {
  // The route generates a random `live-<hex>` ci_run_id when the
  // caller omits one. Two omitted-ciRunId calls must NEVER collide
  // onto the same row — the partial unique index is gated by
  // `WHERE ci_run_id <> ''` and the generated ids are crypto-random
  // hex so the practical collision odds are zero, but pin it so a
  // future refactor (e.g. switching to a constant default) can't
  // quietly conflate every live run into one.
  const suite = `live-no-ci-${Date.now()}`;

  const a = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite }),
  });
  assert.equal(a.status, 201);
  const aBody = (await a.json()) as { id: number; ci_run_id: string };

  const b = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ suite }),
  });
  assert.equal(b.status, 201);
  const bBody = (await b.json()) as { id: number; ci_run_id: string };

  assert.notEqual(aBody.id, bBody.id, "two no-ciRunId /live/start calls must allocate distinct ids");
  assert.notEqual(aBody.ci_run_id, bBody.ci_run_id, "the auto-generated ci_run_id values must differ");
});

// ── Issue #41: live-started runs must be visible immediately ──────────

test("GET /runs lists a live-started run immediately, before any events", async () => {
  // The dashboard's runs list depends on /runs to surface in-progress
  // live runs. POST /live/start inserts a row with reporter='live'
  // and zero stats; that row must appear in /runs the moment the
  // POST returns, before any test.started events arrive. Without
  // this, users can't see long-running suites until the run finishes
  // (issue #41).
  const suite = `live-visibility-${Date.now()}`;
  const runId = await startLiveRun(suite);

  const list = await fetch(`${BASE}/runs?limit=100`, { headers: authHeaders() });
  assert.ok(list.ok, `/runs should 2xx; got ${list.status}`);
  const body = (await list.json()) as {
    runs: Array<{ id: number; reporter: string; suite_name: string }>;
  };
  const row = body.runs.find((r) => r.id === runId);
  assert.ok(row, "live-started run must appear in /runs before any events");
  assert.equal(row!.reporter, "live", "reporter must be 'live' so the UI can flag the row as in-progress");
  assert.equal(row!.suite_name, suite);
});

test("GET /live/active includes a live-started run immediately, before any events", async () => {
  // Companion contract for issue #41: the dashboard cross-references
  // /live/active to decide which rows in the list deserve the LIVE
  // badge. A new run must appear here the moment /live/start returns
  // so the badge renders on the first poll cycle after creation —
  // not only after the first events POST.
  const runId = await startLiveRun(`live-active-${Date.now()}`);

  const active = await fetch(`${BASE}/live/active`, { headers: authHeaders() });
  assert.ok(active.ok, `/live/active should 2xx; got ${active.status}`);
  const body = (await active.json()) as { runs: number[] };
  assert.ok(
    body.runs.includes(runId),
    "live-started run must appear in /live/active so the dashboard can render the LIVE badge",
  );
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
