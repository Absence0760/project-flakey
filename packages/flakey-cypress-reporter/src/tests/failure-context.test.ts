/**
 * Failure-context capture (Phase 13) — plugin side.
 *
 * The support file (browser realm) accumulates command tail, console output,
 * uncaught errors, network failures, and the per-attempt retry trail, then
 * ships them via the `flakey:saveFailureContext` task. The plugin buffers each
 * to a temp file and, in after:run, merges them onto the matching test row
 * (keyed by spec::test) before POSTing /runs — exactly as it already does for
 * command logs.
 *
 * These tests don't run Cypress. They drive the plugin's registered task +
 * after:run handler directly: write a spec buffer + a failure-context file,
 * then assert the uploaded payload carries the merged failure_context.
 */
import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate this file's buffer dirs from reporter.test.ts. `node --test` runs the
// two files in parallel processes that share the real $TMPDIR/flakey-reporter
// base, and reporter.test.ts wipes that whole base in its hooks — without our
// own TMPDIR, that concurrent wipe races our spec-buffer write. Point TMPDIR at
// a per-process dir BEFORE importing the plugin, so the plugin's module-load
// `tmpdir()` (which it caches into FLAKEY_BASE_DIR) resolves under our dir.
const MY_TMP = join(tmpdir(), `flakey-fc-test-${process.pid}`);
mkdirSync(MY_TMP, { recursive: true });
process.env.TMPDIR = MY_TMP;

const { flakeyReporter } = await import("../plugin.ts");

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const RUN_ID = "8642";

const REPORTER_DIR = join(MY_TMP, "flakey-reporter");
const FC_DIR = join(MY_TMP, "flakey-failure-context");
const CMD_DIR = join(MY_TMP, "flakey-commands");

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function wipe() {
  for (const d of [REPORTER_DIR, FC_DIR, CMD_DIR]) {
    rmSync(d, { recursive: true, force: true });
  }
}

// Recording `on` — captures registered task handlers. The after:run handler
// is returned by flakeyReporter when installAfterRun:false, so the tests grab
// it from the return value rather than from an on("after:run") registration.
function recordingOn() {
  const tasks: Record<string, (data: any) => unknown> = {};
  const on = (event: string, payload: any) => {
    if (event === "task") Object.assign(tasks, payload);
  };
  return { on, tasks };
}

let calls: Capture[];

beforeEach(() => {
  wipe();
  process.env.FLAKEY_LIVE_RUN_ID = RUN_ID;
  calls = [];
  globalThis.fetch = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  wipe();
  delete process.env.FLAKEY_LIVE_RUN_ID;
});

function writeSpecBuffer(spec: object) {
  const dir = join(REPORTER_DIR, `run-${RUN_ID}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
}

test("saveFailureContext is merged onto the matching test row before upload", async () => {
  const rec = recordingOn();
  const afterRun = flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false })!;

  assert.equal(typeof rec.tasks["flakey:saveFailureContext"], "function",
    "the plugin must register the flakey:saveFailureContext task");

  // Spec buffer with one failing test (no artifacts → JSON /runs path).
  writeSpecBuffer({
    file_path: "cypress/e2e/login.cy.ts",
    title: "Login",
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 42 },
    tests: [{
      title: "rejects bad password",
      full_title: "Login > rejects bad password",
      status: "failed",
      duration_ms: 42,
      error: { message: "AssertionError" },
      screenshot_paths: [],
    }],
  });

  // Support file ships the failure context for that test.
  rec.tasks["flakey:saveFailureContext"]({
    // The support file sends the FULL describe-path title (matches full_title).
    testTitle: "Login > rejects bad password",
    specFile: "cypress/e2e/login.cy.ts",
    failureContext: {
      commands_tail: [{ name: "get", message: "#password", state: "failed" }],
      browser_console: ["error: boom"],
      network_failures: ["POST /api/login → 500"],
      retry_errors: [{ attempt: 0, message: "AssertionError" }],
    },
  });

  await afterRun({ startedTestsAt: "2026-01-01T00:00:00Z", endedTestsAt: "2026-01-01T00:00:01Z" });

  const runPost = calls.find((c) => c.url.endsWith("/runs"));
  assert.ok(runPost, "expected a POST /runs");
  const body = JSON.parse(runPost.opts.body as string);
  const fc = body.specs[0].tests[0].failure_context;
  assert.ok(fc, "failure_context must be merged onto the test row");
  assert.equal(fc.browser_console[0], "error: boom");
  assert.equal(fc.network_failures[0], "POST /api/login → 500");
  assert.equal(fc.commands_tail[0].name, "get");
  assert.equal(fc.retry_errors[0].attempt, 0);
});

test("two same-leaf-title tests in one spec each get their OWN failure context (keyed by full_title, no cross-attribution)", async () => {
  const rec = recordingOn();
  const afterRun = flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false })!;

  // describe("Create") it("works")  +  describe("Delete") it("works")
  // Same leaf ("works"), same spec, distinct full_title.
  writeSpecBuffer({
    file_path: "items.cy.ts",
    title: "Items",
    stats: { total: 2, passed: 0, failed: 2, skipped: 0, duration_ms: 20 },
    tests: [
      { title: "works", full_title: "Create works", status: "failed", duration_ms: 10, screenshot_paths: [] },
      { title: "works", full_title: "Delete works", status: "failed", duration_ms: 10, screenshot_paths: [] },
    ],
  });

  // The support file ships each test's context keyed by its FULL title.
  rec.tasks["flakey:saveFailureContext"]({
    testTitle: "Create works", specFile: "items.cy.ts",
    failureContext: { browser_console: ["create boom"] },
  });
  rec.tasks["flakey:saveFailureContext"]({
    testTitle: "Delete works", specFile: "items.cy.ts",
    failureContext: { browser_console: ["delete boom"] },
  });

  await afterRun({});

  const body = JSON.parse(calls.find((c) => c.url.endsWith("/runs"))!.opts.body as string);
  const rows = body.specs[0].tests;
  const create = rows.find((t: any) => t.full_title === "Create works");
  const del = rows.find((t: any) => t.full_title === "Delete works");
  // Keyed by leaf, both rows would have received the same (last-written)
  // context. Keyed by full_title, each keeps its own.
  assert.equal(create.failure_context.browser_console[0], "create boom");
  assert.equal(del.failure_context.browser_console[0], "delete boom");
});

test("after:screenshot streams the test title SPACE-joined (matches tests.full_title for backend linking)", async () => {
  // Regression: the handler joined the title path with ' > ', but the backend
  // links the screenshot by matching tests.full_title (Mocha fullTitle() —
  // space-joined). ' > ' never matched, so screenshots for any describe-nested
  // test were stored but never attached to the row.
  const handlers: Record<string, any> = {};
  const on = (event: string, h: any) => { handlers[event] = h; };
  flakeyReporter(on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false });

  const shot = join(MY_TMP, "after-shot.png");
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  await handlers["after:screenshot"]({
    path: shot,
    specName: "login.cy.ts",
    testTitle: ["Auth", "Login", "should sign in"],
  });

  const call = calls.find((c) => c.url.includes("/screenshot"));
  assert.ok(call, "expected a POST /live/:id/screenshot");
  const form = await new Request("http://x/", { method: "POST", body: call.opts.body }).formData();
  assert.equal(form.get("testTitle"), "Auth Login should sign in",
    "title path must be space-joined to match tests.full_title, not ' > '");
});

test("a test with no failure context uploads cleanly (failure_context stays absent)", async () => {
  const rec = recordingOn();
  const afterRun = flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false })!;

  writeSpecBuffer({
    file_path: "a.cy.ts",
    title: "A",
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 5 },
    tests: [{ title: "passes", full_title: "A > passes", status: "passed", duration_ms: 5, screenshot_paths: [] }],
  });

  await afterRun({});

  const runPost = calls.find((c) => c.url.endsWith("/runs"));
  assert.ok(runPost);
  const body = JSON.parse(runPost.opts.body as string);
  assert.equal(body.specs[0].tests[0].failure_context, undefined,
    "no captured context → no failure_context key on the row");
});

test("merge spreads support-side context onto reporter-set resolved_stack (both survive)", async () => {
  const rec = recordingOn();
  const afterRun = flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false })!;

  // Reporter already wrote resolved_stack / code_frame onto the buffered row
  // (source-map resolution happens reporter-side in addTest).
  writeSpecBuffer({
    file_path: "auth.cy.ts",
    title: "A",
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 9 },
    tests: [{
      title: "x",
      full_title: "A > x",
      status: "failed",
      duration_ms: 9,
      screenshot_paths: [],
      failure_context: {
        resolved_stack: [{ file: "auth.cy.ts", line: 42 }],
        code_frame: { file: "auth.cy.ts", line: 42 },
      },
    }],
  });

  // Support file contributes console / network for the same test — keyed by
  // the full describe-path title (matches the buffered row's full_title).
  rec.tasks["flakey:saveFailureContext"]({
    testTitle: "A > x",
    specFile: "auth.cy.ts",
    failureContext: { browser_console: ["error: boom"], network_failures: ["GET /api → 500"] },
  });

  await afterRun({});

  const body = JSON.parse(calls.find((c) => c.url.endsWith("/runs"))!.opts.body as string);
  const fc = body.specs[0].tests[0].failure_context;
  // Reporter-set source-map fields must NOT be clobbered by the support merge.
  assert.equal(fc.resolved_stack[0].line, 42, "reporter-set resolved_stack must survive the merge");
  assert.equal(fc.code_frame.line, 42, "reporter-set code_frame must survive the merge");
  // Support-side fields are added alongside.
  assert.equal(fc.browser_console[0], "error: boom");
  assert.equal(fc.network_failures[0], "GET /api → 500");
});

test("save tasks never throw — a write error returns null instead of failing the test's afterEach", () => {
  // A task that throws makes the support file's afterEach fail, which Cypress
  // counts as the TEST failing — a green test goes red purely because our
  // bookkeeping write hit an error. Capture must never change pass/fail.
  // Force the throw with a circular payload (JSON.stringify rejects it) and
  // assert the handler swallows it and returns null.
  const rec = recordingOn();
  flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false });

  const circular: any = { testTitle: "t", specFile: "s.cy.ts" };
  circular.failureContext = { self: circular }; // circular → JSON.stringify throws

  assert.doesNotThrow(() => {
    const out = rec.tasks["flakey:saveFailureContext"](circular);
    assert.equal(out, null, "the task must return null even when the write throws");
  });

  const circularCmd: any = { testTitle: "t", specFile: "s.cy.ts" };
  circularCmd.commands = [circularCmd]; // circular → JSON.stringify throws
  assert.doesNotThrow(() => {
    assert.equal(rec.tasks["flakey:saveCommandLog"](circularCmd), null);
  });
});

test("the failure-context buffer dir is removed after the run", async () => {
  const rec = recordingOn();
  const afterRun = flakeyReporter(rec.on as any, { reporterOptions: {} }, { url: URL, apiKey: API_KEY, suite: "s", installAfterRun: false })!;

  writeSpecBuffer({
    file_path: "a.cy.ts",
    title: "A",
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 1 },
    tests: [{ title: "x", full_title: "A > x", status: "failed", duration_ms: 1, screenshot_paths: [] }],
  });
  rec.tasks["flakey:saveFailureContext"]({
    testTitle: "A > x",
    specFile: "a.cy.ts",
    failureContext: { uncaught_errors: ["TypeError: nope"] },
  });

  await afterRun({});

  assert.equal(existsSync(join(FC_DIR, `run-${RUN_ID}`)), false,
    "the scoped failure-context buffer dir must be cleaned up after upload");
});
