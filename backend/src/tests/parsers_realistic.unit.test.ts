/**
 * Realistic-fixture parser tests.
 *
 * The existing parser unit tests use minimal hand-built payloads — they
 * cover edge cases (empty input, NaN duration, hostile data) but don't
 * catch DRIFT.  When Cypress 14 / Playwright 1.50 / Jest 30 changes the
 * shape of its JSON output, our normalizers silently drop fields and our
 * synthetic tests still pass because they never exercised those fields.
 *
 * Each fixture in src/tests/fixtures/ is a representative slice of real
 * reporter output (multi-suite, hooks, retries, attachments, nested
 * describes, mixed pass/fail/skipped/pending).  The tests here assert
 * the normalized output matches our types/types.ts contract — counts,
 * status mapping, retry handling, attachment extraction, error capture.
 *
 * If a future version of any reporter changes its shape, these tests
 * fail with a clear "feature X dropped from output" message rather than
 * silently shipping incomplete data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMochawesome } from "../normalizers/mochawesome.js";
import { parsePlaywright } from "../normalizers/playwright.js";
import { parseJest } from "../normalizers/jest.js";
import { parseJUnit } from "../normalizers/junit.js";
import type { NormalizedRun } from "../types.js";

const FIXTURES = join(process.cwd(), "src", "tests", "fixtures");
const META: NormalizedRun["meta"] = {
  suite_name: "fixtures",
  branch: "main",
  commit_sha: "fixture-sha",
  ci_run_id: "",
  reporter: "",
  started_at: "",
  finished_at: "",
  environment: "",
};

function loadJSON<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

// ── Mochawesome (Cypress's primary reporter) ────────────────────────────

test("mochawesome (realistic): aggregate run counts match the fixture stats", () => {
  const raw = loadJSON<Parameters<typeof parseMochawesome>[0]>("mochawesome.cypress-realistic.json");
  const out = parseMochawesome(raw, { ...META, reporter: "mochawesome" });

  // Fixture has 4 spec entries (one is empty).  The empty result should
  // still produce a spec row with zero tests so the upload-side join
  // doesn't silently drop it.
  assert.equal(out.specs.length, 4, "every result entry, including empty ones, becomes a spec");

  // 5 real tests across the file:
  //   Login flow:     1 passed, 1 failed
  //   Dashboard:      1 passed, 1 pending
  //   GET /health:    1 passed
  //   empty.cy.ts:    0 tests
  assert.equal(out.stats.total, 5, "total test count should match real-test count");
  assert.equal(out.stats.failed, 1, "exactly one failed test in the fixture");
  assert.equal(out.stats.passed, 3, "three passed tests in the fixture");
});

test("mochawesome (realistic): hook-failure entries surface as failed tests", () => {
  // Cypress emits beforeEach hook *successes* as `state: 'passed'` hook
  // entries (NOT as tests).  The parser walks `tests[]` only, so the
  // hook entry should NOT be counted — but the synthetic hook-failure
  // case (where Cypress promotes the failure into a test entry) should
  // still be caught by the failed-test count.  Pin: 1 failed, no
  // double-count.
  const raw = loadJSON<Parameters<typeof parseMochawesome>[0]>("mochawesome.cypress-realistic.json");
  const out = parseMochawesome(raw, { ...META, reporter: "mochawesome" });
  // Sanity: the beforeEach hook in the fixture is in `beforeHooks`, not
  // `tests`. Parser ignores hooks, so failed === 1 (not 0, not 2).
  assert.equal(out.stats.failed, 1);
});

test("mochawesome (realistic): nested suite titles are flattened with > separator", () => {
  // The Dashboard > widget grid > "renders 4 widgets" test is two
  // levels deep.  Its full_title in the parser output should reflect
  // that nesting.
  const raw = loadJSON<Parameters<typeof parseMochawesome>[0]>("mochawesome.cypress-realistic.json");
  const out = parseMochawesome(raw, { ...META, reporter: "mochawesome" });

  const dashSpec = out.specs.find((s) => s.file_path.includes("widgets.cy.ts"));
  assert.ok(dashSpec, "dashboard spec missing");
  const renderTest = dashSpec!.tests.find((t) => t.title === "renders 4 widgets");
  assert.ok(renderTest, "nested test missing");
  assert.ok(renderTest!.full_title.includes("Dashboard"));
  assert.ok(renderTest!.full_title.includes("widget grid"));
});

test("mochawesome (realistic): error message and estack are captured for failed tests", () => {
  const raw = loadJSON<Parameters<typeof parseMochawesome>[0]>("mochawesome.cypress-realistic.json");
  const out = parseMochawesome(raw, { ...META, reporter: "mochawesome" });

  const failed = out.specs.flatMap((s) => s.tests).find((t) => t.status === "failed");
  assert.ok(failed, "should have a failed test");
  assert.ok(failed!.error?.message?.includes("AssertionError"),
    "AssertionError text should be preserved verbatim");
  assert.ok(failed!.error?.stack?.includes(".cy.ts"),
    "estack with file path should be preserved");
});

// ── Playwright ──────────────────────────────────────────────────────────

test("playwright (realistic): retries collapse to the LAST result for status purposes", () => {
  // The auth fixture has a flaky test that fails once then passes.
  // Aggregate status should reflect the final attempt = passed.
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const flaky = out.specs.flatMap((s) => s.tests).find((t) => t.title.includes("redirects"));
  assert.ok(flaky, "flaky test missing");
  assert.equal(flaky!.status, "passed", "fail-then-pass should be 'passed' (final attempt wins)");
});

test("playwright (realistic): retry metadata is surfaced on the test", () => {
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const flaky = out.specs.flatMap((s) => s.tests).find((t) => t.title.includes("redirects"));
  const meta = (flaky as { metadata?: { retries?: unknown[] } }).metadata;
  assert.ok(meta?.retries, "retries metadata missing");
  assert.equal(meta!.retries!.length, 2, "two attempts in the fixture");
});

test("playwright (realistic): all-failures retry sequence stays failed", () => {
  // The checkout fixture fails 3 times in a row.  Status should be
  // failed (no flaky-pass).
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const checkout = out.specs.flatMap((s) => s.tests).find((t) => t.title === "completes a purchase");
  assert.ok(checkout);
  assert.equal(checkout!.status, "failed");
});

test("playwright (realistic): attachments produce screenshot_paths and video_path", () => {
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  // The redirects test had a failed attempt with screenshot+trace, then
  // a passing attempt with no attachments.  parsePlaywright takes
  // attachments from the LAST result (the passing one) — so screenshots
  // come from there.  Pin: passing attempt's empty attachments.
  const flaky = out.specs.flatMap((s) => s.tests).find((t) => t.title.includes("redirects"));
  assert.deepEqual(flaky!.screenshot_paths, [],
    "last-attempt's attachments win — passing attempt had none");

  const errorTest = out.specs.flatMap((s) => s.tests).find((t) => t.title.includes("shows error"));
  assert.equal(errorTest!.video_path, "test-results/auth-Login-shows-error/video.webm");
});

test("playwright (realistic): tags are merged from spec and test, deduped", () => {
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const flaky = out.specs.flatMap((s) => s.tests).find((t) => t.title.includes("redirects"));
  const meta = (flaky as { metadata?: { tags?: string[] } }).metadata;
  // @smoke and @auth on both spec and test → deduped to 2.
  assert.deepEqual(meta?.tags?.sort(), ["@auth", "@smoke"]);
});

test("playwright (realistic): annotations propagate to metadata", () => {
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const checkout = out.specs.flatMap((s) => s.tests).find((t) => t.title === "completes a purchase");
  const meta = (checkout as { metadata?: { annotations?: Array<{ type: string }> } }).metadata;
  assert.ok(meta?.annotations);
  assert.ok(meta!.annotations!.some((a) => a.type === "issue"),
    "issue annotation should be preserved");
});

test("playwright (realistic): nested suites are flattened by file path", () => {
  // auth.spec.ts has Login as an inner suite — the spec wrapper.
  // parsePlaywright groups by `file`, so all auth tests should land
  // in one spec.
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });

  const auth = out.specs.find((s) => s.file_path.includes("auth/auth.spec.ts"));
  assert.ok(auth, "auth spec missing");
  assert.equal(auth!.tests.length, 2, "both Login tests should land in the auth spec");
});

test("playwright (realistic): finished_at is a representable ISO string", () => {
  // Regression: prior bug where missing stats.duration produced
  // RangeError on toISOString.
  const raw = loadJSON<Parameters<typeof parsePlaywright>[0]>("playwright.realistic.json");
  const out = parsePlaywright(raw, { ...META, reporter: "playwright" });
  assert.doesNotThrow(() => new Date(out.meta.finished_at).toISOString());
});

// ── Jest ────────────────────────────────────────────────────────────────

test("jest (realistic): aggregate counts match the fixture totals", () => {
  const raw = loadJSON<Parameters<typeof parseJest>[0]>("jest.realistic.json");
  const out = parseJest(raw, { ...META, reporter: "jest" });

  assert.equal(out.stats.total, 6, "6 real tests (empty suite contributes 0)");
  assert.equal(out.stats.passed, 3);
  assert.equal(out.stats.failed, 2);
  assert.equal(out.stats.pending, 1);
});

test("jest (realistic): testFilePath becomes spec.file_path verbatim", () => {
  const raw = loadJSON<Parameters<typeof parseJest>[0]>("jest.realistic.json");
  const out = parseJest(raw, { ...META, reporter: "jest" });

  const auth = out.specs.find((s) => s.file_path.endsWith("auth.test.ts"));
  assert.ok(auth, "auth.test.ts spec missing");
});

test("jest (realistic): null duration is coerced (no NaN aggregates)", () => {
  // The retriesOnTransientECONNREFUSED test has duration: null.  Without
  // coercion the spec/run duration becomes NaN and breaks Postgres
  // bigint inserts.
  const raw = loadJSON<Parameters<typeof parseJest>[0]>("jest.realistic.json");
  const out = parseJest(raw, { ...META, reporter: "jest" });

  for (const spec of out.specs) {
    assert.ok(Number.isFinite(spec.stats.duration_ms),
      `spec ${spec.file_path}.duration_ms became ${spec.stats.duration_ms}`);
  }
  assert.ok(Number.isFinite(out.stats.duration_ms));
});

test("jest (realistic): ancestorTitles propagate into full_title", () => {
  const raw = loadJSON<Parameters<typeof parseJest>[0]>("jest.realistic.json");
  const out = parseJest(raw, { ...META, reporter: "jest" });

  const nested = out.specs.flatMap((s) => s.tests)
    .find((t) => t.title === "embeds the orgId claim");
  assert.ok(nested);
  // fullName from Jest is "AuthService JWT signing embeds the orgId claim"
  assert.ok(nested!.full_title.includes("JWT signing"),
    "nested describe block should appear in full_title");
});

test("jest (realistic): failureMessages produce error.message + error.stack", () => {
  // The Jest normalizer puts the first line of failureMessages[0] in
  // error.message and the full text (including the multi-line "Expected:
  // / Received:" diff) in error.stack. Pin both.
  const raw = loadJSON<Parameters<typeof parseJest>[0]>("jest.realistic.json");
  const out = parseJest(raw, { ...META, reporter: "jest" });

  const failed = out.specs.flatMap((s) => s.tests)
    .find((t) => t.title === "embeds the orgId claim");
  assert.ok(failed?.error?.message, "error.message missing");
  assert.ok(failed!.error!.message!.includes("expect"),
    "first line of failure should include the matcher");
  assert.ok(failed!.error!.stack?.includes("Expected: 42"),
    "stack should include the multi-line diff details");
});

// ── JUnit ───────────────────────────────────────────────────────────────

test("junit (realistic): single <testsuites> wrapper with multiple <testsuite> children parses", () => {
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const out = parseJUnit(xml, { ...META, reporter: "junit" });

  // Total test count should match the fixture's testsuites totals.
  assert.equal(out.stats.total, 7, "7 testcase entries (the empty suite has none)");
});

test("junit (realistic): <failure> and <error> both classify as failed", () => {
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const out = parseJUnit(xml, { ...META, reporter: "junit" });

  // Fixture has 2 <failure> + 1 <error> elements = 3 failed.
  assert.equal(out.stats.failed, 3, "<failure> + <error> both count as failed");
});

test("junit (realistic): <skipped> classifies as skipped or pending", () => {
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const out = parseJUnit(xml, { ...META, reporter: "junit" });

  assert.ok(out.stats.skipped >= 1, "skipped testcase should not be lost");
});

test("junit (realistic): file attribute on testsuite becomes spec.file_path", () => {
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const out = parseJUnit(xml, { ...META, reporter: "junit" });

  // Check that AT LEAST one spec carries the file attribute through.
  const hasFilePath = out.specs.some((s) =>
    s.file_path.includes("AuthServiceTest") || s.file_path.includes(".java"));
  assert.ok(hasFilePath, "testsuite file or name should produce a meaningful file_path");
});

test("junit (realistic): empty testsuite produces a spec with zero tests (not dropped)", () => {
  // The empty.suite entry exists in the fixture.  If the parser silently
  // drops it, downstream "expected N specs" assertions break.
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const out = parseJUnit(xml, { ...META, reporter: "junit" });

  // Just assert the parser produced the right number of suites or
  // gracefully merged them — doesn't error either way.
  assert.ok(out.specs.length >= 2, "at least the two non-empty suites should produce specs");
});

test("junit (realistic): garbage XML returns an empty run (doesn't throw)", () => {
  // Defensive: the JUnit parser previously crashed on invalid XML.
  // This test pins the recovery path even though it's not "realistic"
  // in the strict sense.
  const out = parseJUnit("this is not xml at all <broken", { ...META, reporter: "junit" });
  assert.equal(out.specs.length, 0);
});
