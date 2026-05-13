import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import FlakeyWdioReporter from "../reporter.ts";

/**
 * Unit tests for the post-run WebdriverIO reporter (src/reporter.ts).
 *
 * Drives the reporter through its WDIO lifecycle (onRunnerStart →
 * onSuiteStart → onTestPass/Fail/Skip → onRunnerEnd) with mocked
 * RunnerStats/SuiteStats/TestStats objects, and mocks globalThis.fetch
 * to capture the upload payload sent by the underlying ApiClient.
 *
 * The reporter has zero coverage outside of these tests; a regression
 * in stats accumulation, status mapping, or env-var fallback can ship
 * unnoticed and break the dashboard upload for every WDIO consumer.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "wdio-reporter-suite";
const RUN_ID = 12345;

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    // The post-run upload returns { id: <run-id> } from POST /runs/upload.
    return new Response(JSON.stringify({ id: RUN_ID }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fn, calls };
}

let fetchMock: ReturnType<typeof makeFetchMock>;
beforeEach(() => {
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  // Wipe env vars that fall into the reporter's fallback chain so each
  // test starts from a known state.
  for (const k of [
    "BRANCH", "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "BITBUCKET_BRANCH",
    "COMMIT_SHA", "GITHUB_SHA", "BITBUCKET_COMMIT",
    "CI_RUN_ID", "GITHUB_RUN_ID", "BITBUCKET_BUILD_NUMBER",
    "FLAKEY_RELEASE",
    "FLAKEY_ENV", "TEST_ENV",
  ]) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Minimal stubs that satisfy the @wdio/reporter type expectations.
function runnerStats(start: Date = new Date(2024, 0, 1, 12)): any {
  return { start };
}
function suiteStats(file: string, title?: string): any {
  return { file, title: title ?? "" };
}
function testStats(
  title: string,
  fullTitle: string,
  duration: number,
  err?: { message: string; stack?: string },
): any {
  return {
    title,
    fullTitle,
    duration,
    error: err,
  };
}

/**
 * Pull the NormalizedRun out of whichever endpoint ApiClient picked.
 * When the reporter has zero files attached, ApiClient short-circuits
 * to POST /runs with a JSON body. With files, it sends multipart to
 * POST /runs/upload with the run JSON in the `payload` field.
 */
function uploadPayload(calls: Capture[]): any {
  // Multipart path: /runs/upload
  const multipart = calls.find((c) => c.url.endsWith("/runs/upload"));
  if (multipart) {
    const body = multipart.opts.body;
    if (body && typeof body.get === "function") {
      const payloadField = body.get("payload");
      return JSON.parse(typeof payloadField === "string" ? payloadField : "{}");
    }
  }
  // No-files fast path: /runs with the NormalizedRun as the JSON body
  const json = calls.find((c) => c.url.endsWith("/runs") && c.opts.method === "POST");
  if (json) {
    return JSON.parse(json.opts.body as string);
  }
  throw new Error(`expected POST /runs or /runs/upload — saw ${calls.map((c) => c.url).join(", ")}`);
}

test("env-var fallback: constructor reads FLAKEY_API_URL / FLAKEY_API_KEY / FLAKEY_SUITE when options omit them", async () => {
  // A CI consumer wiring this reporter as `[FlakeyReporter, { logFile }]`
  // (credentials via env vars) must work — without the fallback the
  // ApiClient gets url:"" and every upload throws.
  process.env.FLAKEY_API_URL = "https://env-url.example.com";
  process.env.FLAKEY_API_KEY = "fk_env_key";
  process.env.FLAKEY_SUITE = "env-suite";
  try {
    const r = new FlakeyWdioReporter({ logFile: "/tmp/wdio.log" });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    assert.ok(
      fetchMock.calls.length > 0,
      "env-derived creds must produce a POST",
    );
    const call = fetchMock.calls[0];
    assert.match(call.url, /env-url\.example\.com\/runs(\/upload)?$/);
    assert.equal(call.opts.headers.Authorization, "Bearer fk_env_key");
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.suite_name, "env-suite");
  } finally {
    delete process.env.FLAKEY_API_URL;
    delete process.env.FLAKEY_API_KEY;
    delete process.env.FLAKEY_SUITE;
  }
});

test("options win over env: explicit url/apiKey/suite override FLAKEY_* env vars", async () => {
  process.env.FLAKEY_API_URL = "https://env-url.example.com";
  process.env.FLAKEY_API_KEY = "fk_env_key";
  process.env.FLAKEY_SUITE = "env-suite";
  try {
    const r = new FlakeyWdioReporter({
      url: "https://options-url.example.com",
      apiKey: "fk_options_key",
      suite: "options-suite",
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    const call = fetchMock.calls[0];
    assert.match(call.url, /options-url\.example\.com/);
    assert.equal(call.opts.headers.Authorization, "Bearer fk_options_key");
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.suite_name, "options-suite");
  } finally {
    delete process.env.FLAKEY_API_URL;
    delete process.env.FLAKEY_API_KEY;
    delete process.env.FLAKEY_SUITE;
  }
});

test("constructor stashes options + builds an ApiClient (no fetch yet)", () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  assert.equal(fetchMock.fn.mock.callCount(), 0,
    "no upload should fire on construct alone");
  assert.equal(r.isSynchronised, true,
    "before onRunnerEnd, the reporter is synchronised");
});

test("zero-test run is a no-op (no upload, isSynchronised stays true)", async () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats());
  await r.onRunnerEnd(runnerStats());

  assert.equal(fetchMock.fn.mock.callCount(), 0,
    "zero tests → no upload (the reporter early-returns before POST)");
  assert.equal(r.isSynchronised, true);
});

test("onSuiteStart without a file is ignored — runs without spec context don't crash addTest", async () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats());
  // suite without `file` — older WDIO/mocha emits these for describe blocks.
  r.onSuiteStart({ title: "describe-only" } as any);
  // Test events fire without an active spec — should silently skip
  // (specMap is empty), not crash.
  r.onTestPass(testStats("orphan", "describe-only > orphan", 1));
  await r.onRunnerEnd(runnerStats());

  assert.equal(fetchMock.fn.mock.callCount(), 0,
    "orphan tests stay out of the upload payload entirely");
});

test("onTestPass + onTestFail + onTestSkip accumulate per-spec stats correctly", async () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats(new Date(2024, 0, 1, 9)));
  r.onSuiteStart(suiteStats("test/specs/auth.spec.js", "Auth"));
  r.onTestPass(testStats("login", "Auth > login", 100));
  r.onTestPass(testStats("logout", "Auth > logout", 50));
  r.onTestFail(testStats("bad pwd", "Auth > bad pwd", 200, {
    message: "AssertionError: expected 'ok' to equal 'bad'",
    stack: "stack trace here",
  }));
  r.onTestSkip(testStats("flaky one", "Auth > flaky one", 0));
  await r.onRunnerEnd(runnerStats());

  const payload = uploadPayload(fetchMock.calls);
  assert.equal(payload.specs.length, 1);
  const spec = payload.specs[0];
  assert.equal(spec.file_path, "test/specs/auth.spec.js");
  assert.equal(spec.title, "Auth");
  assert.equal(spec.stats.total, 4);
  assert.equal(spec.stats.passed, 2);
  assert.equal(spec.stats.failed, 1);
  assert.equal(spec.stats.skipped, 1);
  assert.equal(spec.stats.duration_ms, 350);

  // Run-level stats agree with sum-of-specs.
  assert.equal(payload.stats.total, 4);
  assert.equal(payload.stats.passed, 2);
  assert.equal(payload.stats.failed, 1);
  assert.equal(payload.stats.skipped, 1);
  assert.equal(payload.stats.duration_ms, 350);

  // The failed test carries error.message + error.stack; passed tests don't.
  const fail = spec.tests.find((t: any) => t.title === "bad pwd");
  assert.equal(fail.status, "failed");
  assert.equal(fail.error.message, "AssertionError: expected 'ok' to equal 'bad'");
  assert.equal(fail.error.stack, "stack trace here");
  const pass = spec.tests.find((t: any) => t.title === "login");
  assert.equal(pass.status, "passed");
  assert.equal(pass.error, undefined);
});

test("multiple suites (each with their own file) appear as separate specs in the payload", async () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats());

  r.onSuiteStart(suiteStats("test/specs/auth.spec.js", "Auth"));
  r.onTestPass(testStats("a1", "Auth > a1", 10));

  r.onSuiteStart(suiteStats("test/specs/checkout.spec.js", "Checkout"));
  r.onTestFail(testStats("c1", "Checkout > c1", 20, { message: "boom" }));

  await r.onRunnerEnd(runnerStats());

  const payload = uploadPayload(fetchMock.calls);
  assert.equal(payload.specs.length, 2);
  const byFile = (f: string) => payload.specs.find((s: any) => s.file_path === f);
  assert.equal(byFile("test/specs/auth.spec.js")?.stats.passed, 1);
  assert.equal(byFile("test/specs/checkout.spec.js")?.stats.failed, 1);
});

test("falls back to errors[0] when test.error is missing — onTestFail accepts either shape", async () => {
  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats());
  r.onSuiteStart(suiteStats("a.spec.js", "A"));

  // WDIO's test object shape — older versions used `errors: []`, newer
  // ones expose `error`. The reporter checks both.
  r.onTestFail({
    title: "old-shape",
    fullTitle: "A > old-shape",
    duration: 5,
    errors: [{ message: "stack-from-errors-array" }],
  } as any);

  await r.onRunnerEnd(runnerStats());

  const payload = uploadPayload(fetchMock.calls);
  const t = payload.specs[0].tests[0];
  assert.equal(t.error.message, "stack-from-errors-array",
    "WDIO 7-style errors[] should populate the normalized test.error");
});

test("env vars fall through: BRANCH/COMMIT_SHA/CI_RUN_ID populate run.meta when no option is set", async () => {
  process.env.BRANCH = "feat/wdio-test";
  process.env.COMMIT_SHA = "deadbeef";
  process.env.CI_RUN_ID = "ci-99";
  try {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.branch, "feat/wdio-test");
    assert.equal(payload.meta.commit_sha, "deadbeef");
    assert.equal(payload.meta.ci_run_id, "ci-99");
    assert.equal(payload.meta.reporter, "webdriverio");
  } finally {
    delete process.env.BRANCH;
    delete process.env.COMMIT_SHA;
    delete process.env.CI_RUN_ID;
  }
});

test("config option wins over env (option.branch overrides BRANCH env var)", async () => {
  process.env.BRANCH = "from-env";
  process.env.GITHUB_HEAD_REF = "from-gh-env";
  try {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      branch: "from-option",
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.branch, "from-option",
      "explicit option must win over BRANCH or GITHUB_HEAD_REF env vars");
  } finally {
    delete process.env.BRANCH;
    delete process.env.GITHUB_HEAD_REF;
  }
});

test("release option / FLAKEY_RELEASE env adds run.meta.release; absent → field omitted entirely", async () => {
  // No release option, no env → meta.release should NOT exist.
  {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.release, undefined,
      "release should be omitted from the payload when not provided");
  }

  // FLAKEY_RELEASE env should populate it.
  process.env.FLAKEY_RELEASE = "v1.2.3";
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  try {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());

    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.release, "v1.2.3");
  } finally {
    delete process.env.FLAKEY_RELEASE;
  }
});

test("FLAKEY_ENV / TEST_ENV env populate run.meta.environment; absent → field omitted", async () => {
  // No env → omitted entirely.
  {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.environment, undefined);
  }

  // FLAKEY_ENV → forwarded.
  process.env.FLAKEY_ENV = "qa";
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  try {
    const r = new FlakeyWdioReporter({
      url: URL, apiKey: API_KEY, suite: SUITE,
      logFile: "/tmp/wdio.log",
    });
    r.onRunnerStart(runnerStats());
    r.onSuiteStart(suiteStats("a.spec.js", "A"));
    r.onTestPass(testStats("x", "A > x", 1));
    await r.onRunnerEnd(runnerStats());
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.environment, "qa");
  } finally {
    delete process.env.FLAKEY_ENV;
  }
});

test("upload error is caught and logged; isSynchronised eventually flips back to true", async () => {
  // Force the upload to fail.
  fetchMock = {
    fn: mock.fn(async () => {
      throw new Error("network down");
    }),
    calls: [],
  };
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const r = new FlakeyWdioReporter({
    url: URL, apiKey: API_KEY, suite: SUITE,
    logFile: "/tmp/wdio.log",
  });
  r.onRunnerStart(runnerStats());
  r.onSuiteStart(suiteStats("a.spec.js", "A"));
  r.onTestPass(testStats("x", "A > x", 1));

  await r.onRunnerEnd(runnerStats());

  // The reporter swallows the error and prints it. It must restore
  // isSynchronised so WDIO doesn't hang waiting for the reporter.
  assert.equal(r.isSynchronised, true,
    "even after an upload error, isSynchronised must flip back so WDIO can exit");
});
