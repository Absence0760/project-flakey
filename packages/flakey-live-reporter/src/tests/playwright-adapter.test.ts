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

  await r.onEnd({ status: "passed" });

  const events = flattenEvents(fetchMock.calls);
  const byTest = (name: string) => events.find((e) => e.test === name);
  assert.equal(byTest("p")?.type, "test.passed");
  assert.equal(byTest("p")?.duration_ms, 100);
  assert.equal(byTest("f")?.type, "test.failed");
  assert.equal(byTest("f")?.error, "bang");
  assert.equal(byTest("to")?.type, "test.failed", "timedOut should map to test.failed");
  assert.equal(byTest("s")?.type, "test.skipped");
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
