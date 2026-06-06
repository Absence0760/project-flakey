import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The reporter uses `module.exports = FlakeyCypressReporter` — that's a
// CommonJS-style export inside a TypeScript file imported by tsx in
// ESM mode. tsx materialises that as an interop-compatible import:
// the class is reachable as the default export AND as the namespace
// itself. Take the namespace + cast to keep TS happy.
import * as ReporterMod from "../reporter.ts";
const FlakeyCypressReporter =
  // @ts-expect-error — module.exports = X interop; .default may exist on tsx
  (ReporterMod.default ?? ReporterMod) as new (
    runner: any,
    options: any,
  ) => unknown;

/**
 * Unit tests for the Cypress (Mocha) reporter (src/reporter.ts).
 *
 * The reporter:
 *   - listens to runner.on("test"|"pass"|"fail"|"pending"|"end") and
 *     buffers per-spec NormalizedSpec/Test rows;
 *   - on "end", writes one JSON file per spec to a tmp buffer dir
 *     scoped by the live-run id (or unscoped fallback);
 *   - separately fires POST /live/<id>/events when FLAKEY_LIVE_RUN_ID
 *     is set (best-effort fire-and-forget).
 *
 * These tests don't run Cypress — they construct a fake MochaRunner,
 * drive it through the events the reporter listens to, mock fetch for
 * the live event POSTs, and read the buffered tmp files back.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "cy-reporter-suite";

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    return new Response("{}", { status: 200 });
  });
  return { fn, calls };
}

function fakeRunner() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const runner = {
    on: (event: string, fn: (...args: any[]) => void) => {
      handlers.set(event, fn);
    },
    suite: { title: "", file: "", suites: [] as any[], parent: undefined },
  };
  return { runner, handlers };
}

function fakeTest(opts: {
  title: string;
  fullTitle?: string;
  specFile: string;
  specTitle?: string;
  duration?: number;
  err?: { message: string; stack?: string };
  currentRetry?: number;
  retries?: number;
}): any {
  const parent: any = {
    title: opts.specTitle ?? "",
    file: opts.specFile,
    suites: [],
    parent: { title: "" }, // root suite
  };
  return {
    title: opts.title,
    fullTitle: () => opts.fullTitle ?? `${opts.specTitle ?? ""} > ${opts.title}`.trim(),
    file: opts.specFile,
    parent,
    duration: opts.duration ?? 0,
    err: opts.err,
    currentRetry: () => opts.currentRetry ?? 0,
    retries: () => opts.retries ?? 0,
  };
}

let fetchMock: ReturnType<typeof makeFetchMock>;

// The reporter resolves FLAKEY_BASE_DIR = join(tmpdir(), "flakey-reporter")
// at module-load time. We can't redirect that after the import has run, so
// each test cleans the real buffer dir before/after itself instead. The
// path is constant per process, which means we can't run cypress-reporter
// tests in parallel — but node:test runs tests in serial within a file by
// default, so this is fine.
const BUFFER_DIR = join(tmpdir(), "flakey-reporter");

function wipeBufferDir() {
  rmSync(BUFFER_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  wipeBufferDir();
  delete process.env.FLAKEY_LIVE_RUN_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  wipeBufferDir();
  delete process.env.FLAKEY_LIVE_RUN_ID;
});

function readBufferedSpecs(): any[] {
  if (!existsSync(BUFFER_DIR)) return [];
  const out: any[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (e.endsWith(".json")) {
        out.push(JSON.parse(readFileSync(full, "utf8")));
      } else {
        try { walk(full); } catch { /* not a dir */ }
      }
    }
  };
  walk(BUFFER_DIR);
  return out;
}

test("on end, the reporter writes one buffer file per spec containing the normalized rows", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const passed = fakeTest({
    title: "should sign in",
    fullTitle: "Auth > should sign in",
    specFile: "cypress/e2e/auth.cy.ts",
    specTitle: "Auth",
    duration: 100,
  });
  const failed = fakeTest({
    title: "should reject bad pwd",
    fullTitle: "Auth > should reject bad pwd",
    specFile: "cypress/e2e/auth.cy.ts",
    specTitle: "Auth",
    duration: 200,
    err: { message: "AssertionError", stack: "stack" },
  });

  handlers.get("test")!(passed);
  handlers.get("pass")!(passed);
  handlers.get("test")!(failed);
  handlers.get("fail")!(failed, failed.err);
  handlers.get("end")!();

  const specs = readBufferedSpecs();
  assert.equal(specs.length, 1, "exactly one buffer file per spec");
  const spec = specs[0];
  assert.equal(spec.file_path, "cypress/e2e/auth.cy.ts");
  assert.equal(spec.title, "Auth");
  assert.equal(spec.stats.total, 2);
  assert.equal(spec.stats.passed, 1);
  assert.equal(spec.stats.failed, 1);
  assert.equal(spec.stats.duration_ms, 300);

  const fail = spec.tests.find((t: any) => t.title === "should reject bad pwd");
  assert.equal(fail.status, "failed");
  assert.equal(fail.error.message, "AssertionError");
  assert.equal(fail.error.stack, "stack");
});

test("'pending' Mocha event lands as status='skipped' in the normalized row", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const skipped = fakeTest({
    title: "should be enabled later",
    specFile: "a.cy.ts",
    specTitle: "X",
  });
  handlers.get("test")!(skipped);
  handlers.get("pending")!(skipped);
  handlers.get("end")!();

  const specs = readBufferedSpecs();
  assert.equal(specs[0].tests[0].status, "skipped",
    "the reporter normalizes 'pending' (Mocha vocab) to 'skipped' (Flakey schema vocab)");
});

test("multiple specs in the same suite produce separate buffer files", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const a = fakeTest({ title: "a1", specFile: "a.cy.ts", specTitle: "A", duration: 5 });
  const b = fakeTest({ title: "b1", specFile: "b.cy.ts", specTitle: "B", duration: 7 });
  handlers.get("test")!(a);
  handlers.get("pass")!(a);
  handlers.get("test")!(b);
  handlers.get("pass")!(b);
  handlers.get("end")!();

  const specs = readBufferedSpecs();
  assert.equal(specs.length, 2);
  const byFile = (f: string) => specs.find((s) => s.file_path === f);
  assert.equal(byFile("a.cy.ts").stats.passed, 1);
  assert.equal(byFile("b.cy.ts").stats.passed, 1);
});

test("retry handling: a failed test with currentRetry < retries is DROPPED so non-final attempts don't inflate the failed count", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  // 3 attempts: first two fail (currentRetry 0 and 1), third passes.
  // The reporter's addTest must skip the first two failures.
  const t = fakeTest({
    title: "flaky",
    specFile: "a.cy.ts",
    specTitle: "F",
    duration: 100,
    retries: 2,
    currentRetry: 0,
    err: { message: "first" },
  });

  handlers.get("test")!(t);
  handlers.get("fail")!(t, t.err);
  // currentRetry getter returns 1 now — drop again.
  (t as any).currentRetry = () => 1;
  handlers.get("test")!(t);
  handlers.get("fail")!(t, { message: "second" });
  // Final attempt passes.
  (t as any).currentRetry = () => 2;
  handlers.get("test")!(t);
  handlers.get("pass")!(t);

  handlers.get("end")!();

  const specs = readBufferedSpecs();
  const rows = specs[0]?.tests ?? [];
  assert.equal(rows.length, 1, "only the final-attempt result should be buffered");
  assert.equal(rows[0].status, "passed");
  assert.equal(specs[0].stats.failed, 0,
    "non-final retry failures must not pollute the failed count");
});

test("test row carries title + full_title from Mocha's fullTitle()", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const t = fakeTest({
    title: "should sign in",
    fullTitle: "Auth flow > should sign in",
    specFile: "auth.cy.ts",
    specTitle: "Auth flow",
  });
  handlers.get("test")!(t);
  handlers.get("pass")!(t);
  handlers.get("end")!();

  const row = readBufferedSpecs()[0].tests[0];
  assert.equal(row.title, "should sign in");
  assert.equal(row.full_title, "Auth flow > should sign in");
});

test("when FLAKEY_LIVE_RUN_ID is set, the reporter fires POST /live/<id>/events for test.started + test.passed", async () => {
  process.env.FLAKEY_LIVE_RUN_ID = "1234";
  try {
    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
    });

    const t = fakeTest({
      title: "x",
      fullTitle: "A > x",
      specFile: "a.cy.ts",
      specTitle: "A",
      duration: 50,
    });
    handlers.get("test")!(t);
    handlers.get("pass")!(t);
    handlers.get("end")!();

    // sendLiveEvent is fire-and-forget — let microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));

    const liveCalls = fetchMock.calls.filter((c) => c.url.includes("/live/1234/events"));
    assert.ok(liveCalls.length >= 2,
      `expected at least one test.started + one test.passed POST, saw ${liveCalls.length}`);
    const eventTypes = liveCalls.flatMap((c) => {
      const body = JSON.parse(c.opts.body as string);
      return Array.isArray(body) ? body.map((e) => e.type) : [body.type];
    });
    assert.ok(eventTypes.includes("test.started"));
    assert.ok(eventTypes.includes("test.passed"));
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("without FLAKEY_LIVE_RUN_ID and no buffer file in the ancestor chain, NO live event is fired", async () => {
  // Default beforeEach already deletes FLAKEY_LIVE_RUN_ID and uses a
  // fresh TMPDIR (so no live-run-id file exists).
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const t = fakeTest({
    title: "x",
    fullTitle: "A > x",
    specFile: "a.cy.ts",
    specTitle: "A",
  });
  handlers.get("test")!(t);
  handlers.get("pass")!(t);
  handlers.get("end")!();

  await new Promise((resolve) => setImmediate(resolve));

  const liveCalls = fetchMock.calls.filter((c) => c.url.includes("/live/"));
  assert.equal(liveCalls.length, 0,
    "no /live/<id>/events POSTs without an active live run");
});

test("without url + apiKey, no live event is fired even when FLAKEY_LIVE_RUN_ID is set", async () => {
  process.env.FLAKEY_LIVE_RUN_ID = "5555";
  try {
    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { suite: SUITE }, // no url, no apiKey
    });

    const t = fakeTest({ title: "x", specFile: "a.cy.ts", specTitle: "A" });
    handlers.get("test")!(t);
    handlers.get("pass")!(t);
    handlers.get("end")!();

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchMock.fn.mock.callCount(), 0,
      "missing url/apiKey must short-circuit before fetch");
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("buffer dir is scoped by FLAKEY_LIVE_RUN_ID when set (run-<id> subfolder)", () => {
  process.env.FLAKEY_LIVE_RUN_ID = "777";
  try {
    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
    });
    const t = fakeTest({ title: "x", specFile: "a.cy.ts", specTitle: "A" });
    handlers.get("test")!(t);
    handlers.get("pass")!(t);
    handlers.get("end")!();

    const scopedDir = join(BUFFER_DIR, "run-777");
    const files = readdirSync(scopedDir);
    assert.ok(files.some((f) => f.endsWith(".json")),
      `expected buffer JSON inside run-777/, saw ${files.join(", ")}`);
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("a failing test without err arg AND without test.err (defensive) still buffers cleanly", () => {
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  const t = fakeTest({ title: "naked-fail", specFile: "a.cy.ts", specTitle: "A" });
  handlers.get("test")!(t);
  // Mocha sometimes emits 'fail' without err (cy.task throw, etc.).
  handlers.get("fail")!(t, undefined);
  handlers.get("end")!();

  const row = readBufferedSpecs()[0].tests[0];
  assert.equal(row.status, "failed");
  // No error object since neither arg nor test.err had one — must NOT crash.
  assert.equal(row.error, undefined);
});

test("'end' with zero tests collected (run aborted before first test) does not throw and writes no buffer files", () => {
  // Client workflow: a Cypress run aborts before a single test runs (e.g. a
  // beforeAll/config crash). The reporter still gets 'end' — it must not throw,
  // and saveToTmp over an empty specMap must be a clean no-op (no buffer files).
  const { runner, handlers } = fakeRunner();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new (FlakeyCypressReporter as any)(runner, {
    reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
  });

  // No 'test'/'pass'/'fail'/'pending' events at all — straight to 'end'.
  assert.doesNotThrow(() => handlers.get("end")!());

  const specs = readBufferedSpecs();
  assert.equal(specs.length, 0, "an aborted run with zero tests writes no buffer files");
});

test("'end' with zero tests fires no live events even when a live run is active", async () => {
  // The empty-run path must not POST any /live events — there were no tests to
  // report — but it also must not throw on the way to a no-op 'end'.
  process.env.FLAKEY_LIVE_RUN_ID = "9090";
  try {
    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
    });

    assert.doesNotThrow(() => handlers.get("end")!());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchMock.fn.mock.callCount(), 0,
      "no tests means no live-event POSTs");
    // Buffer dir scoped to the run-id still gets created by saveToTmp, but holds
    // no spec files.
    assert.equal(readBufferedSpecs().length, 0);
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("a live-event POST that REJECTS is swallowed: buffering and the final buffer write are unaffected", async () => {
  // Client workflow: mid-run the backend becomes unreachable and fetch() rejects
  // (DNS failure / connection refused / abort). Live events are fire-and-forget
  // — the .catch must absorb the rejection so it never surfaces as an
  // unhandledRejection and never interrupts buffering or the end-of-run write.
  process.env.FLAKEY_LIVE_RUN_ID = "4242";

  // Trap any unhandledRejection that escapes the reporter's .catch — if one
  // fires, the fire-and-forget contract is broken.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    // First POST (test.started) succeeds; every POST after that rejects, so we
    // exercise the failure path mid-stream rather than from the first event.
    let callCount = 0;
    const calls: Capture[] = [];
    const failingFetch = mock.fn(async (url: string, opts: any) => {
      calls.push({ url, opts });
      callCount++;
      if (callCount === 1) return new Response("{}", { status: 200 });
      throw new Error("ECONNREFUSED: backend unreachable");
    });
    globalThis.fetch = failingFetch as unknown as typeof fetch;

    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
    });

    const t = fakeTest({
      title: "keeps going",
      fullTitle: "Resilient > keeps going",
      specFile: "a.cy.ts",
      specTitle: "Resilient",
      duration: 33,
    });

    // Driving the events must not throw despite the rejecting fetch.
    assert.doesNotThrow(() => {
      handlers.get("test")!(t);   // test.started -> POST #1 (ok)
      handlers.get("pass")!(t);   // test.passed  -> POST #2 (rejects)
      handlers.get("end")!();
    });

    // Let the fire-and-forget promises settle so any escaped rejection would land.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(unhandled.length, 0,
      `a rejecting live-event fetch must be swallowed by .catch, saw ${unhandled.length} unhandledRejection(s)`);
    assert.ok(callCount >= 2, "both the started and passed events attempted a POST");

    // Buffering is unaffected: the spec + test row are still written to disk.
    const specs = readBufferedSpecs();
    assert.equal(specs.length, 1, "the buffer write proceeds despite the failed live POST");
    assert.equal(specs[0].tests[0].title, "keeps going");
    assert.equal(specs[0].stats.passed, 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("a live-event POST that resolves with a 5xx does not throw and does not interrupt buffering", async () => {
  // fetch() resolving with a non-2xx Response is NOT a rejection — the reporter
  // ignores the response entirely (it never inspects status), so a 5xx is a
  // silent no-op. Assert the run still buffers cleanly and nothing throws.
  process.env.FLAKEY_LIVE_RUN_ID = "5050";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const fiveHundred = mock.fn(async () =>
      new Response("upstream boom", { status: 503 }));
    globalThis.fetch = fiveHundred as unknown as typeof fetch;

    const { runner, handlers } = fakeRunner();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new (FlakeyCypressReporter as any)(runner, {
      reporterOptions: { url: URL, apiKey: API_KEY, suite: SUITE },
    });

    const t = fakeTest({
      title: "survives 5xx",
      specFile: "a.cy.ts",
      specTitle: "S",
      duration: 12,
    });
    assert.doesNotThrow(() => {
      handlers.get("test")!(t);
      handlers.get("pass")!(t);
      handlers.get("end")!();
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(unhandled.length, 0, "a 5xx live response must not surface as a rejection");
    assert.ok(fiveHundred.mock.callCount() >= 2, "live POSTs were attempted");

    const specs = readBufferedSpecs();
    assert.equal(specs.length, 1);
    assert.equal(specs[0].stats.passed, 1, "buffering unaffected by the 5xx live response");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});
