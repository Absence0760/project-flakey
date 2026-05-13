import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import FlakeyPlaywrightReporter from "../reporter.ts";

/**
 * Unit tests for the post-run Playwright reporter (src/reporter.ts).
 *
 * Drives the reporter through onTestEnd → onEnd with mocked Playwright
 * test/result objects, and stubs globalThis.fetch to capture the upload
 * payload. Covers the bits of the reporter that aren't testable end-to-
 * end via the e2e suite:
 *   - retry handling (failed-but-not-final-retry tests are dropped so
 *     counts don't double-count)
 *   - status mapping (passed/failed/timedOut/interrupted/skipped)
 *   - attachment classification (image vs video vs trace)
 *   - per-spec aggregation when one onTestEnd fires for multiple specs
 *   - env-var fallback chain for branch / commit / ci-run-id / release
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "playwright-reporter-suite";
const RUN_ID = 9876;

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
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

// Mock helpers — Playwright test / result objects shaped just enough to
// satisfy the reporter's accesses.
function pwTest(opts: {
  title: string;
  parentTitle?: string;
  file: string;
  retries?: number;
  titlePath?: string[];
}): any {
  const titlePath = opts.titlePath ?? [opts.parentTitle ?? "", opts.title].filter(Boolean);
  return {
    title: opts.title,
    titlePath: () => titlePath,
    location: { file: opts.file, line: 1, column: 1 },
    parent: { title: opts.parentTitle ?? "", location: { file: opts.file } },
    retries: opts.retries ?? 0,
  };
}
function pwResult(opts: {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
  retry?: number;
  errorMessage?: string;
  errorStack?: string;
  attachments?: { name: string; path?: string; contentType: string }[];
}): any {
  return {
    status: opts.status,
    duration: opts.duration ?? 0,
    retry: opts.retry ?? 0,
    error: opts.errorMessage
      ? { message: opts.errorMessage, stack: opts.errorStack }
      : undefined,
    attachments: opts.attachments ?? [],
  };
}

function uploadPayload(calls: Capture[]): any {
  const multipart = calls.find((c) => c.url.endsWith("/runs/upload"));
  if (multipart) {
    const body = multipart.opts.body;
    if (body && typeof body.get === "function") {
      const payloadField = body.get("payload");
      return JSON.parse(typeof payloadField === "string" ? payloadField : "{}");
    }
  }
  const json = calls.find((c) => c.url.endsWith("/runs") && c.opts.method === "POST");
  if (json) return JSON.parse(json.opts.body as string);
  throw new Error(`expected POST /runs or /runs/upload — saw ${calls.map((c) => c.url).join(", ")}`);
}

test("status mapping: passed / failed / timedOut / interrupted / skipped → normalized statuses", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });

  r.onTestEnd(
    pwTest({ title: "p", file: "a.spec.ts", titlePath: ["A", "p"] }),
    pwResult({ status: "passed", duration: 100 }),
  );
  r.onTestEnd(
    pwTest({ title: "f", file: "a.spec.ts", titlePath: ["A", "f"] }),
    pwResult({ status: "failed", duration: 200, errorMessage: "boom" }),
  );
  r.onTestEnd(
    pwTest({ title: "to", file: "a.spec.ts", titlePath: ["A", "to"] }),
    pwResult({ status: "timedOut", duration: 5000 }),
  );
  r.onTestEnd(
    pwTest({ title: "int", file: "a.spec.ts", titlePath: ["A", "int"] }),
    pwResult({ status: "interrupted", duration: 0 }),
  );
  r.onTestEnd(
    pwTest({ title: "s", file: "a.spec.ts", titlePath: ["A", "s"] }),
    pwResult({ status: "skipped", duration: 0 }),
  );

  await r.onEnd({ status: "failed" });

  const payload = uploadPayload(fetchMock.calls);
  const byTitle = (t: string) => payload.specs[0].tests.find((x: any) => x.title === t);
  assert.equal(byTitle("p").status, "passed");
  assert.equal(byTitle("f").status, "failed");
  // timedOut + interrupted both collapse to 'failed' in the normalized
  // schema — the dashboard treats them identically (both block release).
  assert.equal(byTitle("to").status, "failed",
    "timedOut should map to failed");
  assert.equal(byTitle("int").status, "failed",
    "interrupted should map to failed");
  assert.equal(byTitle("s").status, "skipped");

  // Spec stats: 1 passed, 3 failed (real fail + timedOut + interrupted), 1 skipped.
  assert.equal(payload.specs[0].stats.passed, 1);
  assert.equal(payload.specs[0].stats.failed, 3);
  assert.equal(payload.specs[0].stats.skipped, 1);
  assert.equal(payload.specs[0].stats.total, 5);
});

test("retry handling: a failed test with retry < retries is DROPPED (only the final outcome reaches the upload)", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });

  // Test configured with 2 retries (3 total attempts). First two attempts
  // fail; final attempt passes. Reporter should ignore retries 0 and 1.
  const t = pwTest({ title: "flaky", file: "a.spec.ts", retries: 2, titlePath: ["A", "flaky"] });
  r.onTestEnd(t, pwResult({ status: "failed", retry: 0, duration: 100, errorMessage: "first try" }));
  r.onTestEnd(t, pwResult({ status: "failed", retry: 1, duration: 110, errorMessage: "second try" }));
  r.onTestEnd(t, pwResult({ status: "passed", retry: 2, duration: 120 }));

  await r.onEnd({ status: "passed" });

  const payload = uploadPayload(fetchMock.calls);
  // Exactly one row for "flaky" — non-final-retry failures must not
  // pollute the totals.
  const matches = payload.specs[0].tests.filter((x: any) => x.title === "flaky");
  assert.equal(matches.length, 1, "only the final-attempt result reaches upload");
  assert.equal(matches[0].status, "passed");
  assert.equal(payload.specs[0].stats.total, 1);
  assert.equal(payload.specs[0].stats.passed, 1);
  assert.equal(payload.specs[0].stats.failed, 0,
    "the two earlier failed retries must NOT count toward failed");
});

test("a final-retry FAILED test (retry == retries) is kept", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  const t = pwTest({ title: "always-fails", file: "a.spec.ts", retries: 2, titlePath: ["A", "always-fails"] });

  r.onTestEnd(t, pwResult({ status: "failed", retry: 0, errorMessage: "1" }));
  r.onTestEnd(t, pwResult({ status: "failed", retry: 1, errorMessage: "2" }));
  r.onTestEnd(t, pwResult({ status: "failed", retry: 2, duration: 50, errorMessage: "final" }));

  await r.onEnd({ status: "failed" });

  const payload = uploadPayload(fetchMock.calls);
  const rows = payload.specs[0].tests;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].error.message, "final",
    "the kept row should carry the FINAL retry's error, not the first attempt's");
});

test("attachment classification: image/* → screenshots, video/* → videos, application/zip → traces", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });

  r.onTestEnd(
    pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
    pwResult({
      status: "failed",
      duration: 100,
      errorMessage: "see screenshot",
      attachments: [
        { name: "shot1.png", path: "/tmp/shot1.png", contentType: "image/png" },
        { name: "shot2.jpg", path: "/tmp/shot2.jpg", contentType: "image/jpeg" },
        { name: "video.webm", path: "/tmp/video.webm", contentType: "video/webm" },
        { name: "trace.zip", path: "/tmp/trace.zip", contentType: "application/zip" },
        { name: "stdout.txt", path: "/tmp/stdout.txt", contentType: "text/plain" },
        // missing-path attachment — must be dropped, not throw.
        { name: "no-path", contentType: "image/png" },
      ],
    }),
  );

  await r.onEnd({ status: "failed" });

  const payload = uploadPayload(fetchMock.calls);
  const t = payload.specs[0].tests[0];
  // Both image attachments arrive as screenshot_paths; first video wins
  // for video_path; trace.zip is consumed by the trace handler at
  // onEnd (the test won't reflect it as a screenshot/video).
  assert.deepEqual(t.screenshot_paths, ["/tmp/shot1.png", "/tmp/shot2.jpg"]);
  assert.equal(t.video_path, "/tmp/video.webm");
  // text/plain and no-path attachments must NOT show up anywhere.
  assert.equal(JSON.stringify(payload).includes("stdout.txt"), false);
  assert.equal(JSON.stringify(payload).includes("no-path"), false);
});

test("multiple specs: each test's location.file gets its own spec entry", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });

  r.onTestEnd(
    pwTest({ title: "a1", file: "tests/auth.spec.ts", parentTitle: "Auth", titlePath: ["Auth", "a1"] }),
    pwResult({ status: "passed", duration: 10 }),
  );
  r.onTestEnd(
    pwTest({ title: "c1", file: "tests/checkout.spec.ts", parentTitle: "Checkout", titlePath: ["Checkout", "c1"] }),
    pwResult({ status: "failed", duration: 20, errorMessage: "x" }),
  );

  await r.onEnd({ status: "failed" });

  const payload = uploadPayload(fetchMock.calls);
  assert.equal(payload.specs.length, 2);
  const byFile = (f: string) => payload.specs.find((s: any) => s.file_path === f);
  assert.equal(byFile("tests/auth.spec.ts").stats.passed, 1);
  assert.equal(byFile("tests/checkout.spec.ts").stats.failed, 1);
  assert.equal(payload.specs.length, 2);
});

test("full_title is built from titlePath() joined with ' > ' (matches the cypress/wdio convention)", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  r.onTestEnd(
    pwTest({
      title: "should sign in",
      file: "auth.spec.ts",
      titlePath: ["", "auth.spec.ts", "Auth flow", "should sign in"],
    }),
    pwResult({ status: "passed", duration: 1 }),
  );
  await r.onEnd({ status: "passed" });

  const payload = uploadPayload(fetchMock.calls);
  assert.equal(
    payload.specs[0].tests[0].full_title,
    "auth.spec.ts > Auth flow > should sign in",
    "empty titlePath segments must be filtered out",
  );
});

test("env vars fall through: BRANCH/COMMIT_SHA/CI_RUN_ID populate run.meta when no option is set", async () => {
  process.env.BRANCH = "feat/pw";
  process.env.COMMIT_SHA = "deadbeef";
  process.env.CI_RUN_ID = "ci-pw-1";
  try {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });

    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.branch, "feat/pw");
    assert.equal(payload.meta.commit_sha, "deadbeef");
    assert.equal(payload.meta.ci_run_id, "ci-pw-1");
    assert.equal(payload.meta.reporter, "playwright");
  } finally {
    delete process.env.BRANCH;
    delete process.env.COMMIT_SHA;
    delete process.env.CI_RUN_ID;
  }
});

test("FLAKEY_RELEASE env populates run.meta.release; absent → field omitted", async () => {
  // No release → omitted entirely.
  {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.release, undefined);
  }

  process.env.FLAKEY_RELEASE = "v9.9.9";
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  try {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.release, "v9.9.9");
  } finally {
    delete process.env.FLAKEY_RELEASE;
  }
});

test("FLAKEY_ENV / TEST_ENV env populate run.meta.environment; absent → field omitted", async () => {
  // No env → omitted entirely.
  {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.environment, undefined);
  }

  // FLAKEY_ENV → forwarded.
  process.env.FLAKEY_ENV = "qa";
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  try {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.environment, "qa");
  } finally {
    delete process.env.FLAKEY_ENV;
  }

  // config.environment wins over env.
  process.env.FLAKEY_ENV = "qa";
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  try {
    const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE, environment: "stage" });
    r.onTestEnd(
      pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
      pwResult({ status: "passed", duration: 1 }),
    );
    await r.onEnd({ status: "passed" });
    const payload = uploadPayload(fetchMock.calls);
    assert.equal(payload.meta.environment, "stage");
  } finally {
    delete process.env.FLAKEY_ENV;
  }
});

test("upload error is caught — onEnd resolves cleanly even when the network fails", async () => {
  fetchMock = {
    fn: mock.fn(async () => {
      throw new Error("ECONNREFUSED");
    }),
    calls: [],
  };
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  r.onTestEnd(
    pwTest({ title: "x", file: "a.spec.ts", titlePath: ["A", "x"] }),
    pwResult({ status: "passed", duration: 1 }),
  );
  // Must not throw. Reporter logs and returns.
  await r.onEnd({ status: "passed" });
});

test("onEnd with zero collected tests still POSTs (covers the 'all tests skipped' edge — playwright sometimes calls onEnd without onTestEnd)", async () => {
  const r = new FlakeyPlaywrightReporter({ url: URL, apiKey: API_KEY, suite: SUITE });
  await r.onEnd({ status: "passed" });

  // The reporter does not early-return on empty specMap (it still POSTs
  // a totals=0 run so the dashboard gets a record). Pin this contract;
  // changing it would silently regress the "0 tests detected" surface.
  const payload = uploadPayload(fetchMock.calls);
  assert.equal(payload.specs.length, 0);
  assert.equal(payload.stats.total, 0);
});
