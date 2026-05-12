/**
 * LiveEventBus unit tests — covers the in-memory bus behaviour added
 * by the /live/stream SSE work (roadmap Phase 12 / commit e133342):
 *
 *   - subscribeOrg returns an unsubscribe function
 *   - addActive emits one active.add per run (idempotent)
 *   - removeActive emits one active.remove per run
 *   - active.remove fires from unregister() BEFORE runMeta is cleared
 *     (so the delta carries the correct orgId)
 *   - org isolation: org A's subscriber never sees org B's deltas
 *   - run.finished and run.aborted both produce active.remove
 *   - registering a run then emitting run.started yields active.add
 *
 * These run in-process against the singleton (no HTTP, no DB) so they
 * lock down the bus contract that the SSE route depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { liveEvents, type ActiveRunsDelta, type LiveTestEvent } from "../live-events.js";

// Counter so each test uses a unique runId / orgId space and the
// singleton's state doesn't leak between tests.
let next = 1_000_000;
function freshIds() {
  const runId = next++;
  const orgId = next++;
  return { runId, orgId };
}

function collect(orgId: number): { deltas: ActiveRunsDelta[]; off: () => void } {
  const deltas: ActiveRunsDelta[] = [];
  const off = liveEvents.subscribeOrg(orgId, (d) => deltas.push(d));
  return { deltas, off };
}

test("subscribeOrg delivers active.add when a registered run gets a run.started event", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.deepEqual(deltas, [{ type: "active.add", runId }]);
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});

test("addActive is idempotent — a second run.started for the same run does not re-emit", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.equal(deltas.length, 1, "duplicate run.started must not emit a second active.add");
    assert.equal(deltas[0].type, "active.add");
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});

test("run.finished emits exactly one active.remove", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    liveEvents.emit(runId, { type: "run.finished", runId, timestamp: Date.now() });
    assert.deepEqual(deltas, [
      { type: "active.add", runId },
      { type: "active.remove", runId },
    ]);
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});

test("run.aborted also emits active.remove (parity with run.finished)", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    liveEvents.emit(runId, { type: "run.aborted", runId, timestamp: Date.now(), error: "test" });
    assert.deepEqual(deltas, [
      { type: "active.add", runId },
      { type: "active.remove", runId },
    ]);
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});

test("unregister() emits active.remove BEFORE clearing runMeta (delta has correct orgId)", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.equal(deltas.length, 1);
    liveEvents.unregister(runId);
    // If removeActive ran AFTER runMeta.delete, the orgId lookup
    // inside addActive/removeActive would return undefined and the
    // delta would be skipped — leaving deltas.length === 1.
    assert.deepEqual(deltas, [
      { type: "active.add", runId },
      { type: "active.remove", runId },
    ]);
  } finally {
    off();
  }
});

test("subscribeOrg returns an unsubscribe function that stops further deltas", () => {
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.equal(deltas.length, 1);
    off();
    liveEvents.emit(runId, { type: "run.finished", runId, timestamp: Date.now() });
    assert.equal(deltas.length, 1, "no further deltas after unsubscribe");
  } finally {
    liveEvents.unregister(runId);
  }
});

test("cross-tenant: a subscriber for org A never sees deltas for runs in org B", () => {
  const { runId: runA, orgId: orgA } = freshIds();
  const { runId: runB, orgId: orgB } = freshIds();
  const a = collect(orgA);
  const b = collect(orgB);
  try {
    liveEvents.registerRun(runA, orgA);
    liveEvents.registerRun(runB, orgB);

    liveEvents.emit(runA, { type: "run.started", runId: runA, timestamp: Date.now() });
    liveEvents.emit(runB, { type: "run.started", runId: runB, timestamp: Date.now() });

    assert.deepEqual(a.deltas, [{ type: "active.add", runId: runA }]);
    assert.deepEqual(b.deltas, [{ type: "active.add", runId: runB }]);

    liveEvents.emit(runA, { type: "run.finished", runId: runA, timestamp: Date.now() });

    assert.deepEqual(a.deltas, [
      { type: "active.add", runId: runA },
      { type: "active.remove", runId: runA },
    ]);
    assert.deepEqual(b.deltas, [{ type: "active.add", runId: runB }], "org B unaffected by org A's finish");
  } finally {
    a.off();
    b.off();
    liveEvents.unregister(runA);
    liveEvents.unregister(runB);
  }
});

test("multiple subscribers for the same org all receive the same deltas (fan-out)", () => {
  const { runId, orgId } = freshIds();
  const s1 = collect(orgId);
  const s2 = collect(orgId);
  const s3 = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    liveEvents.emit(runId, { type: "run.finished", runId, timestamp: Date.now() });

    const expected: ActiveRunsDelta[] = [
      { type: "active.add", runId },
      { type: "active.remove", runId },
    ];
    assert.deepEqual(s1.deltas, expected);
    assert.deepEqual(s2.deltas, expected);
    assert.deepEqual(s3.deltas, expected);
  } finally {
    s1.off();
    s2.off();
    s3.off();
    liveEvents.unregister(runId);
  }
});

test("getActiveRunIds(orgId) reflects the same state the deltas describe", () => {
  const { runId, orgId } = freshIds();
  try {
    assert.deepEqual(liveEvents.getActiveRunIds(orgId), [], "fresh org starts empty");

    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.deepEqual(liveEvents.getActiveRunIds(orgId), [runId], "after run.started, list contains the run");

    liveEvents.emit(runId, { type: "run.finished", runId, timestamp: Date.now() });
    assert.deepEqual(liveEvents.getActiveRunIds(orgId), [], "after run.finished, list is empty again");
  } finally {
    liveEvents.unregister(runId);
  }
});

test("a late-subscribing org A still gets deltas for already-registered runs (snapshot is the route's job, not the bus's)", () => {
  // The bus emits deltas only on state changes. Late subscribers see
  // only events that happen AFTER they subscribe — the SSE route
  // sends a separate `snapshot` payload from getActiveRunIds() to
  // bridge that gap. This test pins the contract so a future
  // refactor doesn't try to replay deltas inside subscribeOrg.
  const { runId, orgId } = freshIds();
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });

    const late = collect(orgId);
    try {
      // Subscriber attached AFTER run.started — should see NOTHING yet.
      assert.deepEqual(late.deltas, []);
      // But getActiveRunIds reflects the run is active — that's what
      // the SSE route uses for its initial snapshot.
      assert.deepEqual(liveEvents.getActiveRunIds(orgId), [runId]);
      // A subsequent state change is delivered.
      liveEvents.emit(runId, { type: "run.finished", runId, timestamp: Date.now() });
      assert.deepEqual(late.deltas, [{ type: "active.remove", runId }]);
    } finally {
      late.off();
    }
  } finally {
    liveEvents.unregister(runId);
  }
});

test("touch() does not emit deltas (heartbeat-only path)", () => {
  // touch() is the empty-events-POST heartbeat that resets lastEventAt
  // without observably changing state. The bus must not fire deltas
  // from this path — every poll cycle of an SSE subscriber would
  // otherwise see noise events for any live reporter.
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });
    assert.equal(deltas.length, 1);
    liveEvents.touch(runId);
    liveEvents.touch(runId);
    liveEvents.touch(runId);
    assert.equal(deltas.length, 1, "touch() must not produce any deltas");
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});

test("non-lifecycle events (test.passed, spec.finished, etc.) do not emit active.add/remove", () => {
  // Only run.started / run.finished / run.aborted change the active
  // set. Test-level events shouldn't churn the org delta stream.
  const { runId, orgId } = freshIds();
  const { deltas, off } = collect(orgId);
  try {
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });

    const noise: LiveTestEvent[] = [
      { type: "spec.started", runId, timestamp: Date.now(), spec: "x" },
      { type: "test.started", runId, timestamp: Date.now(), test: "a" },
      { type: "test.passed", runId, timestamp: Date.now(), test: "a" },
      { type: "test.failed", runId, timestamp: Date.now(), test: "b" },
      { type: "test.skipped", runId, timestamp: Date.now(), test: "c" },
      { type: "spec.finished", runId, timestamp: Date.now(), spec: "x" },
    ];
    for (const e of noise) liveEvents.emit(runId, e);

    assert.deepEqual(deltas, [{ type: "active.add", runId }],
      "lifecycle-only — test-level events must not produce deltas");
  } finally {
    off();
    liveEvents.unregister(runId);
  }
});
