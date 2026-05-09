import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import WebdriverIOLiveReporter from "../webdriverio.ts";

/**
 * Unit-tests the WebdriverIO reporter adapter (src/webdriverio.ts).
 * WDIO is unusual in this set: it does NOT have an onTestStart hook, so
 * test rows materialise directly in their terminal state. The adapter
 * also receives a `file` field on test events (full path), and falls
 * back to `parent` when the file is missing.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "wdio-suite";
const ASSIGNED_RUN_ID = 5151;
const ASSIGNED_CI_RUN_ID = "live-wdio-bagel";

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

test("WebdriverIOLiveReporter is inert without url + apiKey", async () => {
  const r = new WebdriverIOLiveReporter({});
  await r.onRunnerStart();
  r.onTestPass({ title: "x", file: "a.spec.js", duration: 1 });
  await r.onRunnerEnd();
  assert.equal(fetchMock.fn.mock.callCount(), 0);
});

test("onRunnerStart POSTs /live/start and sends run.started", async () => {
  const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onRunnerStart();
  await r.onRunnerEnd();

  const startCall = fetchMock.calls.find((c) => c.url.endsWith("/live/start"));
  assert.ok(startCall);
  const events = flattenEvents(fetchMock.calls);
  assert.equal(events[0]?.type, "run.started");
});

test("onSuiteStart emits spec.started with the suite file (preferring suite.file over suite.title)", async () => {
  const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onRunnerStart();

  r.onSuiteStart({ file: "test/specs/auth.spec.js", title: "auth" });
  r.onSuiteStart({ title: "fallback-by-title-only" });
  await r.onRunnerEnd();

  const specStarts = flattenEvents(fetchMock.calls).filter((e) => e.type === "spec.started");
  assert.equal(specStarts.length, 2);
  assert.equal(specStarts[0].spec, "test/specs/auth.spec.js", "prefers file over title");
  assert.equal(specStarts[1].spec, "fallback-by-title-only");
});

test("onTestPass / onTestFail / onTestSkip emit test.passed / test.failed / test.skipped (no test.started — WDIO has no onTestStart hook)", async () => {
  const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onRunnerStart();

  r.onTestPass({ title: "p", file: "a.spec.js", duration: 100 });
  r.onTestFail({ title: "f", file: "a.spec.js", duration: 250, error: { message: "kaboom" } });
  r.onTestSkip({ title: "s", file: "a.spec.js" });

  await r.onRunnerEnd();

  const events = flattenEvents(fetchMock.calls);
  // ZERO test.started events from this adapter — the absence is the contract.
  assert.equal(events.filter((e) => e.type === "test.started").length, 0,
    "WDIO adapter must not emit test.started events");

  const byTest = (name: string) => events.find((e) => e.test === name);
  assert.equal(byTest("p")?.type, "test.passed");
  assert.equal(byTest("p")?.duration_ms, 100);
  assert.equal(byTest("p")?.status, "passed");
  assert.equal(byTest("f")?.type, "test.failed");
  assert.equal(byTest("f")?.error, "kaboom");
  assert.equal(byTest("f")?.status, "failed");
  assert.equal(byTest("s")?.type, "test.skipped");
  assert.equal(byTest("s")?.status, "skipped");
});

test("test.* events fall back to test.parent when test.file is undefined", async () => {
  const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onRunnerStart();

  r.onTestPass({ title: "no-file", parent: "describe block as spec", duration: 5 });
  await r.onRunnerEnd();

  const events = flattenEvents(fetchMock.calls);
  const passed = events.find((e) => e.test === "no-file");
  assert.equal(passed?.spec, "describe block as spec",
    "spec should fall back to test.parent when test.file is missing");
});

test("onRunnerEnd sends run.finished as the LAST event and flushes the queue", async () => {
  const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onRunnerStart();
  r.onSuiteStart({ file: "test/specs/x.spec.js" });
  r.onTestPass({ title: "x", file: "test/specs/x.spec.js", duration: 1 });
  await r.onRunnerEnd();

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events.at(-1)?.type, "run.finished",
    "run.finished must be the final event");
});

test("preset config.runId bypasses /live/start", async () => {
  const r = new WebdriverIOLiveReporter({
    url: URL, apiKey: API_KEY, suite: SUITE, runId: 1234,
  });
  await r.onRunnerStart();
  r.onTestPass({ title: "x", file: "a.spec.js", duration: 1 });
  await r.onRunnerEnd();

  assert.equal(
    fetchMock.calls.find((c) => c.url.endsWith("/live/start")),
    undefined,
    "preset runId should bypass /live/start",
  );
  const eventCall = fetchMock.calls.find((c) => c.url.includes("/events"));
  assert.ok(eventCall?.url.endsWith("/live/1234/events"));
});

test("after /live/start sets process.env.CI_RUN_ID for the main reporter merge", async () => {
  delete process.env.CI_RUN_ID;
  try {
    const r = new WebdriverIOLiveReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    await r.onRunnerStart();
    await r.onRunnerEnd();
    assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID);
  } finally {
    delete process.env.CI_RUN_ID;
  }
});
