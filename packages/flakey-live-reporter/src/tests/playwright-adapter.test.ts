import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import PlaywrightLiveReporter from "../playwright.ts";

/**
 * Unit-tests the Playwright reporter adapter (src/playwright.ts) by
 * mocking globalThis.fetch and Playwright's reporter callback shape.
 * These tests catch regressions in the per-hook event mapping that
 * the e2e suites can't see — they only assert what arrives at the
 * server, never which adapter code produced it.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "playwright-suite";
const ASSIGNED_RUN_ID = 4242;
const ASSIGNED_CI_RUN_ID = "live-pw-cafef00d";

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    if (url.endsWith("/live/start")) {
      return new Response(
        JSON.stringify({ id: ASSIGNED_RUN_ID, ci_run_id: ASSIGNED_CI_RUN_ID }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  });
  return { fn, calls };
}

// Pull the JSON body of every POST to /live/<id>/events into a flat
// chronological array of LiveTestEvent-shaped objects so individual
// tests can read them by index.
function flattenEvents(calls: Capture[]): any[] {
  const out: any[] = [];
  for (const c of calls) {
    if (!c.url.includes("/events")) continue;
    const body = JSON.parse(c.opts.body as string);
    if (Array.isArray(body)) out.push(...body);
  }
  return out;
}

let fetchMock: ReturnType<typeof makeFetchMock>;
beforeEach(() => {
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("PlaywrightLiveReporter is inert without url + apiKey (no /live/start, no events)", async () => {
  const r = new PlaywrightLiveReporter({});
  await r.onBegin({}, { allTests: () => [] });
  r.onTestBegin({ title: "t", parent: { location: { file: "a.spec.ts" } } });
  await r.onEnd({ status: "passed" });
  assert.equal(fetchMock.fn.mock.callCount(), 0, "no fetch when missing creds");
});

test("onBegin POSTs /live/start with suite + branch + commitSha + ciRunId, then sends run.started", async () => {
  const r = new PlaywrightLiveReporter({
    url: URL,
    apiKey: API_KEY,
    suite: SUITE,
    branch: "feat/x",
    commitSha: "abc1234",
    ciRunId: "ci-1",
  });
  await r.onBegin({}, { allTests: () => [{}, {}, {}] });
  await r.onEnd({ status: "passed" });

  const startCall = fetchMock.calls.find((c) => c.url.endsWith("/live/start"));
  assert.ok(startCall, "expected POST /live/start");
  assert.equal(startCall.opts.method, "POST");
  assert.equal(startCall.opts.headers.Authorization, `Bearer ${API_KEY}`);
  const startBody = JSON.parse(startCall.opts.body as string);
  assert.equal(startBody.suite, SUITE);
  assert.equal(startBody.branch, "feat/x");
  assert.equal(startBody.commitSha, "abc1234");
  assert.equal(startBody.ciRunId, "ci-1");

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events[0].type, "run.started", "first event is run.started");
  assert.deepEqual(events[0].stats, { total: 3, passed: 0, failed: 0, skipped: 0 });
});

test("onTestBegin emits test.started with title + spec from parent.location.file", async () => {
  const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onBegin({}, { allTests: () => [{}] });
  r.onTestBegin({ title: "should sign in", parent: { location: { file: "tests/auth/login.spec.ts" } } });
  await r.onEnd({ status: "passed" });

  const events = flattenEvents(fetchMock.calls);
  const started = events.find((e) => e.type === "test.started");
  assert.ok(started, "test.started should be emitted");
  assert.equal(started.test, "should sign in");
  assert.equal(started.spec, "tests/auth/login.spec.ts");
});

test("onTestEnd maps result.status → test.passed / test.failed / test.skipped (and timedOut → failed)", async () => {
  const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onBegin({}, { allTests: () => [{}, {}, {}, {}] });

  r.onTestEnd(
    { title: "p", parent: { location: { file: "a.spec.ts" } } },
    { status: "passed", duration: 100 },
  );
  r.onTestEnd(
    { title: "f", parent: { location: { file: "a.spec.ts" } } },
    { status: "failed", duration: 250, error: { message: "bang" } },
  );
  r.onTestEnd(
    { title: "to", parent: { location: { file: "a.spec.ts" } } },
    { status: "timedOut", duration: 5_000, error: { message: "timeout" } },
  );
  r.onTestEnd(
    { title: "s", parent: { location: { file: "a.spec.ts" } } },
    { status: "skipped", duration: 0 },
  );
  // "interrupted" = process killed mid-test (Ctrl-C / CI job kill). It is a
  // failure, NOT a skip — a killed job must not paint in-flight tests green-
  // adjacent on the live dashboard.
  r.onTestEnd(
    { title: "int", parent: { location: { file: "a.spec.ts" } } },
    { status: "interrupted", duration: 0 },
  );

  await r.onEnd({ status: "passed" });

  const events = flattenEvents(fetchMock.calls);
  const byTest = (name: string) => events.find((e) => e.test === name);
  assert.equal(byTest("p")?.type, "test.passed");
  assert.equal(byTest("p")?.duration_ms, 100);
  assert.equal(byTest("f")?.type, "test.failed");
  assert.equal(byTest("f")?.error, "bang");
  assert.equal(byTest("to")?.type, "test.failed", "timedOut should map to test.failed");
  assert.equal(byTest("s")?.type, "test.skipped");
  assert.equal(byTest("int")?.type, "test.failed", "interrupted should map to test.failed, not skipped");
});

test("a non-numeric /live/start id is rejected — no events stream to a garbage run id", async () => {
  // A backend that returns a string/UUID/NaN id is truthy, so the `!this.runId`
  // check wouldn't catch it; without validation the adapter would build
  // /live/<garbage>/events and 404 every event. The guard must skip the stream.
  fetchMock = {
    fn: mock.fn(async (url: string, opts: any) => {
      fetchMock.calls.push({ url, opts });
      if (url.endsWith("/live/start")) {
        return new Response(JSON.stringify({ id: "not-a-number", ci_run_id: "x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
    calls: [],
  };
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onBegin({}, { allTests: () => [{}] });
  r.onTestEnd({ title: "x", parent: { location: { file: "a.spec.ts" } } }, { status: "passed", duration: 1 });
  await r.onEnd({ status: "passed" });

  // /live/start was called, but NO /events POST went out — the bad id is dropped.
  assert.ok(fetchMock.calls.some((c) => c.url.endsWith("/live/start")));
  assert.equal(
    fetchMock.calls.filter((c) => c.url.includes("/events")).length, 0,
    "no events stream when /live/start returns a non-numeric id",
  );
});

test("onEnd emits run.finished and flushes the queue (no events left buffered)", async () => {
  const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onBegin({}, { allTests: () => [{}] });
  r.onTestBegin({ title: "x", parent: { location: { file: "a.spec.ts" } } });
  r.onTestEnd(
    { title: "x", parent: { location: { file: "a.spec.ts" } } },
    { status: "passed", duration: 50 },
  );
  await r.onEnd({ status: "passed" });

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events.at(-1)?.type, "run.finished", "run.finished is the LAST event");
});

test("preset config.runId skips /live/start and uses the supplied id directly", async () => {
  const r = new PlaywrightLiveReporter({
    url: URL, apiKey: API_KEY, suite: SUITE, runId: 999,
  });
  await r.onBegin({}, { allTests: () => [{}] });
  await r.onEnd({ status: "passed" });

  const startCall = fetchMock.calls.find((c) => c.url.endsWith("/live/start"));
  assert.equal(startCall, undefined, "preset runId should bypass /live/start");

  const eventCall = fetchMock.calls.find((c) => c.url.includes("/events"));
  assert.ok(eventCall, "events should still POST");
  assert.ok(eventCall.url.endsWith("/live/999/events"), "events go to the supplied runId");
});

test("FLAKEY_LIVE_RUN_ID env var is honoured when no config.runId is given", async () => {
  process.env.FLAKEY_LIVE_RUN_ID = "777";
  try {
    const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await r.onBegin({}, { allTests: () => [{}] });
    await r.onEnd({ status: "passed" });

    assert.equal(
      fetchMock.calls.find((c) => c.url.endsWith("/live/start")),
      undefined,
      "FLAKEY_LIVE_RUN_ID should also bypass /live/start",
    );
    const eventCall = fetchMock.calls.find((c) => c.url.includes("/events"));
    assert.ok(eventCall?.url.endsWith("/live/777/events"));
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("trailing slash on `url` is stripped so paths don't double up", async () => {
  const r = new PlaywrightLiveReporter({
    url: `${URL}/`, apiKey: API_KEY, suite: SUITE, runId: 1,
  });
  await r.onBegin({}, { allTests: () => [{}] });
  await r.onEnd({ status: "passed" });

  const eventCall = fetchMock.calls.find((c) => c.url.includes("/events"));
  assert.ok(eventCall?.url === `${URL}/live/1/events`,
    "expected single-slash URL, got " + eventCall?.url);
});

test("after /live/start sets process.env.CI_RUN_ID for the main reporter to pick up", async () => {
  delete process.env.CI_RUN_ID;
  try {
    const r = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await r.onBegin({}, { allTests: () => [{}] });
    await r.onEnd({ status: "passed" });
    assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID,
      "CI_RUN_ID env should be set so the post-run reporter merges into the live placeholder");
  } finally {
    delete process.env.CI_RUN_ID;
  }
});

// --- Multi-instance / sharding workflow -------------------------------------
// Playwright spawns one reporter instance per worker/shard. Each instance owns
// its own runId and must stream only to its own /live/<id>/events; constructing
// or finishing one instance must not corrupt another's transport. The events
// queue and LiveClient live as instance fields (no module-level mutable state),
// so isolation should hold — these tests lock that in.

// Filter the flat event list to only those POSTed to a specific runId's URL.
function eventsForRunId(calls: Capture[], runId: number): any[] {
  const out: any[] = [];
  for (const c of calls) {
    if (!c.url.endsWith(`/live/${runId}/events`)) continue;
    const body = JSON.parse(c.opts.body as string);
    if (Array.isArray(body)) out.push(...body);
  }
  return out;
}

test("two instances with preset runIds each POST events only to their own /live/<id>/events", async () => {
  const a = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 100 });
  const b = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 200 });

  await a.onBegin({}, { allTests: () => [{}] });
  await b.onBegin({}, { allTests: () => [{}, {}] });

  // Interleave per-test events across the two instances, as concurrent workers would.
  a.onTestBegin({ title: "a-test", parent: { location: { file: "a.spec.ts" } } });
  b.onTestBegin({ title: "b-test", parent: { location: { file: "b.spec.ts" } } });
  a.onTestEnd(
    { title: "a-test", parent: { location: { file: "a.spec.ts" } } },
    { status: "passed", duration: 10 },
  );
  b.onTestEnd(
    { title: "b-test", parent: { location: { file: "b.spec.ts" } } },
    { status: "failed", duration: 20, error: { message: "boom" } },
  );

  await a.onEnd({ status: "passed" });
  await b.onEnd({ status: "failed" });

  // No preset-runId instance should hit /live/start.
  assert.equal(
    fetchMock.calls.filter((c) => c.url.endsWith("/live/start")).length,
    0,
    "preset runIds must bypass /live/start entirely",
  );

  const aEvents = eventsForRunId(fetchMock.calls, 100);
  const bEvents = eventsForRunId(fetchMock.calls, 200);

  // Each instance's stream contains exactly its own tests — no leakage.
  assert.deepEqual(
    aEvents.map((e) => e.test).filter(Boolean),
    ["a-test", "a-test"],
    "instance A stream must contain only a-test events",
  );
  assert.deepEqual(
    bEvents.map((e) => e.test).filter(Boolean),
    ["b-test", "b-test"],
    "instance B stream must contain only b-test events",
  );

  // run.started stats reflect each instance's own allTests() count, not a shared one.
  assert.deepEqual(aEvents.find((e) => e.type === "run.started")?.stats,
    { total: 1, passed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(bEvents.find((e) => e.type === "run.started")?.stats,
    { total: 2, passed: 0, failed: 0, skipped: 0 });

  // Each instance's terminal run.finished carries its own status.
  assert.equal(aEvents.at(-1)?.type, "run.finished");
  assert.equal(aEvents.at(-1)?.status, "passed");
  assert.equal(bEvents.at(-1)?.type, "run.finished");
  assert.equal(bEvents.at(-1)?.status, "failed");
});

test("onEnd on one instance does not break the other instance's ability to send", async () => {
  const a = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 100 });
  const b = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 200 });

  await a.onBegin({}, { allTests: () => [{}] });
  await b.onBegin({}, { allTests: () => [{}] });

  // Instance A finishes (flush + stop + teardown) while B is still mid-run.
  await a.onEnd({ status: "passed" });

  // B keeps emitting AFTER A's onEnd — must still flush to B's own runId.
  b.onTestBegin({ title: "late-b", parent: { location: { file: "b.spec.ts" } } });
  b.onTestEnd(
    { title: "late-b", parent: { location: { file: "b.spec.ts" } } },
    { status: "passed", duration: 5 },
  );
  await b.onEnd({ status: "passed" });

  const bEvents = eventsForRunId(fetchMock.calls, 200);
  const lateStart = bEvents.find((e) => e.type === "test.started" && e.test === "late-b");
  assert.ok(lateStart, "B must still send test.started after A.onEnd()");
  assert.ok(bEvents.find((e) => e.type === "test.passed" && e.test === "late-b"),
    "B must still send test.passed after A.onEnd()");
  assert.equal(bEvents.at(-1)?.type, "run.finished", "B's own run.finished still lands last");

  // None of B's late events leaked onto A's runId.
  const aEvents = eventsForRunId(fetchMock.calls, 100);
  assert.equal(aEvents.filter((e) => e.test === "late-b").length, 0,
    "B's late events must never appear on A's stream");
});

test("preset-runId instances never overwrite process.env.CI_RUN_ID; a /live/start instance reads the inherited value", async () => {
  // Real behavior: only the /live/start path writes process.env.CI_RUN_ID
  // (playwright.ts line ~80). Preset-runId instances skip /live/start, so they
  // leave CI_RUN_ID untouched — there is no per-instance reset.
  const SENTINEL = "ci-from-outer-env";
  process.env.CI_RUN_ID = SENTINEL;
  try {
    const presetA = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 100 });
    const presetB = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE, runId: 200 });
    await presetA.onBegin({}, { allTests: () => [{}] });
    await presetB.onBegin({}, { allTests: () => [{}] });
    await presetA.onEnd({ status: "passed" });
    await presetB.onEnd({ status: "passed" });

    assert.equal(process.env.CI_RUN_ID, SENTINEL,
      "preset-runId instances must not touch process.env.CI_RUN_ID");

    // Now a /live/start instance with the same ambient CI_RUN_ID: it forwards
    // the inherited value into the start body, then OVERWRITES the env with the
    // server-assigned ci_run_id — shared global state, mutated for siblings.
    const starter = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await starter.onBegin({}, { allTests: () => [{}] });
    await starter.onEnd({ status: "passed" });

    const startCall = fetchMock.calls.find((c) => c.url.endsWith("/live/start"));
    assert.ok(startCall, "expected the no-runId instance to POST /live/start");
    const startBody = JSON.parse(startCall.opts.body as string);
    assert.equal(startBody.ciRunId, SENTINEL,
      "the inherited CI_RUN_ID should be forwarded to /live/start");
    assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID,
      "the /live/start instance overwrites the shared CI_RUN_ID with the server-assigned value");
  } finally {
    delete process.env.CI_RUN_ID;
  }
});

test("a second /live/start instance overwrites the CI_RUN_ID a prior instance set (last-writer-wins on shared env)", async () => {
  delete process.env.CI_RUN_ID;
  try {
    const first = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await first.onBegin({}, { allTests: () => [{}] });
    await first.onEnd({ status: "passed" });
    assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID,
      "first /live/start instance sets CI_RUN_ID");

    // Both instances get the same ci_run_id back from the shared mock, so we
    // can't distinguish writers by value. Instead assert the second instance
    // DID forward the first's value as its own start-body fallback — proving
    // the env is shared, not per-instance.
    const second = new PlaywrightLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await second.onBegin({}, { allTests: () => [{}] });
    await second.onEnd({ status: "passed" });

    const startCalls = fetchMock.calls.filter((c) => c.url.endsWith("/live/start"));
    assert.equal(startCalls.length, 2, "each no-runId instance makes its own /live/start");
    const secondBody = JSON.parse(startCalls[1].opts.body as string);
    assert.equal(secondBody.ciRunId, ASSIGNED_CI_RUN_ID,
      "second instance inherits the CI_RUN_ID the first wrote — env is process-global, not isolated");
    assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID);
  } finally {
    delete process.env.CI_RUN_ID;
  }
});
