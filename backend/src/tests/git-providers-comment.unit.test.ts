/**
 * PR/MR comment formatter unit tests.
 *
 * buildCommentBody is the only client-visible formatter for the PR/MR
 * comment Flakey posts after a run. It must emit valid markdown for every
 * edge case — a malformed comment is what the customer actually sees on
 * their pull request, so the formatting contract is load-bearing:
 *   - no failure-details section when nothing failed
 *   - the failed-test list caps at 20 with an "...and N more" footnote
 *   - duration formatting is correct across the ms/s/m/h boundaries
 *   - long names / null errors / newline-laden errors don't break markdown
 *   - the flaky list caps at 10, and is absent when there are none
 *   - the headline Status agrees with classifyRunStatus (the badge / API ship
 *     signal) — a run with pending tests reads "Incomplete", never a false green
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommentBody, formatDuration, COMMENT_MARKER } from "../git-providers/comment.js";
import type { NormalizedRun, NormalizedTest, NormalizedSpec } from "../types.js";

function mkTest(over: Partial<NormalizedTest> = {}): NormalizedTest {
  return {
    title: "renders the widget",
    full_title: "Widget > renders the widget",
    status: "passed",
    duration_ms: 12,
    screenshot_paths: [],
    ...over,
  };
}

function mkSpec(over: Partial<NormalizedSpec> = {}): NormalizedSpec {
  const tests = over.tests ?? [mkTest()];
  return {
    file_path: "tests/widget.spec.ts",
    title: "widget.spec.ts",
    stats: { total: tests.length, passed: tests.length, failed: 0, skipped: 0, pending: 0, duration_ms: 100 },
    tests,
    ...over,
  };
}

function mkRun(over: { stats?: Partial<NormalizedRun["stats"]>; specs?: NormalizedSpec[] } = {}): NormalizedRun {
  return {
    meta: {
      suite_name: "CI Suite",
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id: "999",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
      reporter: "playwright",
    },
    stats: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      duration_ms: 100,
      ...over.stats,
    },
    specs: over.specs ?? [mkSpec()],
  };
}

const URL = "https://flakey.io";

// ── always-present scaffolding ──────────────────────────────────────────

test("body starts with the marker so findExistingComment can re-edit it", () => {
  const body = buildCommentBody(mkRun(), 7, URL, "", []);
  assert.ok(body.startsWith(COMMENT_MARKER), "marker must lead the body for update detection");
  assert.ok(body.includes(`[View full report →](${URL}/runs/7)`), "links to the run by id");
});

// ── empty failed_tests: summary table only, no failure-details section ──

test("all-passing run renders the summary table and NO failure-details section", () => {
  const body = buildCommentBody(mkRun(), 1, URL, "", []);
  // summary table is present
  assert.ok(body.includes("| Metric | Value |"));
  assert.ok(body.includes("| **Pass Rate** | 100.0% (1/1) |"));
  assert.ok(body.includes("✅"), "passing icon");
  // no failure-details <details> block at all
  assert.ok(!body.includes("Failed Test"), `should not render a failed-tests section: ${body}`);
  assert.ok(!body.includes("<details"), "no collapsible details when nothing failed and nothing flaky");
});

// ── >20 failed tests: exactly 20 shown + "...and N more" footnote ───────

test(">20 failed tests: exactly 20 listed plus an '...and N more' footnote", () => {
  const tests = Array.from({ length: 25 }, (_, i) =>
    mkTest({
      status: "failed",
      full_title: `Suite > failing test number ${i}`,
      error: { message: `boom ${i}` },
    })
  );
  const spec = mkSpec({
    tests,
    stats: { total: 25, passed: 0, failed: 25, skipped: 0, pending: 0, duration_ms: 500 },
  });
  const run = mkRun({ stats: { total: 25, passed: 0, failed: 25 }, specs: [spec] });
  const body = buildCommentBody(run, 1, URL, "", []);

  // Count rendered failed-test list items (lines beginning with "- **").
  const listItems = body.split("\n").filter((l) => l.startsWith("- **"));
  assert.equal(listItems.length, 20, "exactly 20 of 25 failed tests are listed");

  // The 20th (index 19) is shown, the 21st (index 20) is not.
  assert.ok(body.includes("failing test number 19"), "20th failure is shown");
  assert.ok(!body.includes("failing test number 20"), "21st failure is NOT shown");

  // Footnote names the remaining count.
  assert.ok(body.includes("_...and 5 more_"), `footnote must say 5 more: ${body}`);

  // The summary header reflects the full count, not the truncated list.
  assert.ok(body.includes("25 Failed Tests"), "summary uses the true failed count");
});

test("exactly 20 failed tests: all 20 shown, no footnote", () => {
  const tests = Array.from({ length: 20 }, (_, i) =>
    mkTest({ status: "failed", full_title: `t${i}`, error: { message: "x" } })
  );
  const spec = mkSpec({
    tests,
    stats: { total: 20, passed: 0, failed: 20, skipped: 0, pending: 0, duration_ms: 1 },
  });
  const body = buildCommentBody(mkRun({ stats: { total: 20, passed: 0, failed: 20 }, specs: [spec] }), 1, URL, "", []);
  const listItems = body.split("\n").filter((l) => l.startsWith("- **"));
  assert.equal(listItems.length, 20);
  assert.ok(!body.includes("more_"), "no footnote when the count is exactly at the cap");
});

// ── formatDuration boundaries ───────────────────────────────────────────

test("formatDuration covers the ms/s/m/h boundaries", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(60_000), "1m");          // 60s → 1m, no remainder
  assert.equal(formatDuration(59_000), "59s");          // just under a minute
  assert.equal(formatDuration(61_000), "1m 1s");        // minute + remainder seconds
  assert.equal(formatDuration(3_600_000), "60m");       // 1h is rendered as 60m (no hour unit)
  assert.equal(formatDuration(3_661_000), "61m 1s");
});

test("Duration row in the body uses formatDuration", () => {
  const body = buildCommentBody(mkRun({ stats: { duration_ms: 61_000 } }), 1, URL, "", []);
  assert.ok(body.includes("| **Duration** | 1m 1s |"), `duration row should be 1m 1s: ${body}`);
});

// ── very long test name (>200 chars): markdown not broken ───────────────

test("a >200-char test name is rendered without breaking markdown structure", () => {
  const longName = "X".repeat(500);
  const spec = mkSpec({
    tests: [mkTest({ status: "failed", full_title: longName, error: { message: "fail" } })],
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 1 },
  });
  const body = buildCommentBody(mkRun({ stats: { total: 1, passed: 0, failed: 1 }, specs: [spec] }), 1, URL, "", []);

  // The list item must be a single line — a long name must not inject a
  // newline that would break the markdown list / details block.
  const itemLine = body.split("\n").find((l) => l.startsWith("- **"));
  assert.ok(itemLine, "the failed test is listed");
  assert.ok(itemLine!.includes(longName), "the full name is present on one line");
  // Bold markers stay balanced on the same line.
  assert.ok(itemLine!.startsWith("- **") && itemLine!.includes("** —"), "bold wrapper intact");
  // Details block remains well-formed.
  assert.ok(body.includes("</details>"), "details block closes");
});

// ── null/undefined error message: not rendered as literal 'null' ────────

test("a failed test with NO error object renders the title but no quote line", () => {
  const spec = mkSpec({
    tests: [mkTest({ status: "failed", full_title: "no-error failure", error: undefined })],
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 1 },
  });
  const body = buildCommentBody(mkRun({ stats: { total: 1, passed: 0, failed: 1 }, specs: [spec] }), 1, URL, "", []);

  assert.ok(body.includes("no-error failure"), "the failure is still listed");
  // No blockquote line and never the literal string "null"/"undefined".
  const lines = body.split("\n");
  assert.ok(!lines.some((l) => l.trim().startsWith(">")), "no empty blockquote when there's no error");
  assert.ok(!body.includes("null"), "must never render the literal 'null'");
  assert.ok(!body.includes("undefined"), "must never render the literal 'undefined'");
});

// ── newlines in error messages: don't break markdown quoting ────────────

test("a multi-line error message stays inside the failed-tests block", () => {
  const spec = mkSpec({
    tests: [
      mkTest({
        status: "failed",
        full_title: "multiline error",
        error: { message: "Expected 1\nReceived 2\n  at foo.ts:10" },
      }),
    ],
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 1 },
  });
  const body = buildCommentBody(mkRun({ stats: { total: 1, passed: 0, failed: 1 }, specs: [spec] }), 1, URL, "", []);

  // The error is short (<200 chars) so it's not truncated; the body must
  // contain the raw message and still close the details block after it.
  assert.ok(body.includes("Expected 1\nReceived 2"), "the error text is present");
  const detailsEnd = body.indexOf("</details>");
  const quoteStart = body.indexOf("> Expected 1");
  assert.ok(quoteStart !== -1 && detailsEnd > quoteStart, "error quote sits inside the details block");
});

test("an error message >200 chars is truncated to 197 chars + ellipsis", () => {
  const longErr = "E".repeat(400);
  const spec = mkSpec({
    tests: [mkTest({ status: "failed", full_title: "long error", error: { message: longErr } })],
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 1 },
  });
  const body = buildCommentBody(mkRun({ stats: { total: 1, passed: 0, failed: 1 }, specs: [spec] }), 1, URL, "", []);
  assert.ok(body.includes("> " + "E".repeat(197) + "..."), "long error truncated to 197 + ellipsis");
  assert.ok(!body.includes("E".repeat(198)), "the untruncated error must not appear");
});

// ── flaky list: capped at 10 + footnote; absent when none ───────────────

test("no flaky section when the flaky list is empty", () => {
  const body = buildCommentBody(mkRun(), 1, URL, "", []);
  assert.ok(!body.includes("Flaky Test"), "no flaky section when none are flaky");
});

test("flaky list >10 is capped at 10 entries", () => {
  const flaky = Array.from({ length: 14 }, (_, i) => `Flaky suite > case ${i}`);
  const body = buildCommentBody(mkRun(), 1, URL, "", flaky);

  // Header reflects the true flaky count.
  assert.ok(body.includes("14 Flaky Tests"), "flaky header uses the full count");

  // Only the first 10 are listed (lines that are flaky bullets: "- " but
  // not the failed-test "- **" form).
  const flakyLines = body.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- **"));
  assert.equal(flakyLines.length, 10, "exactly 10 flaky entries are rendered");
  assert.ok(body.includes("case 9"), "10th flaky entry shown");
  assert.ok(!body.includes("case 10"), "11th flaky entry NOT shown");
});

test("single flaky test uses singular 'Flaky Test' in the header", () => {
  const body = buildCommentBody(mkRun(), 1, URL, "", ["only one"]);
  assert.ok(body.includes("1 Flaky Test<"), `singular header expected: ${body}`);
});

// ── headline status agrees with classifyRunStatus (no false green) ──────
//
// The comment is a ship signal posted on the PR, so its Status row must match
// the badge / GET /runs/status — both of which derive from classifyRunStatus.
// The prior `failed > 0 ? Failed : Passed` heuristic ignored pending tests, so
// an unfinished run (failed = 0 but not every test accounted for) read a
// contradictory green "Passed". These lock the agreement.

test("a run with pending tests (failed=0, total > passed+skipped) is Incomplete, not Passed", () => {
  // 8 passed, 0 failed, 0 skipped, 2 pending → total 10. classifyRunStatus → incomplete.
  const tests = [
    ...Array.from({ length: 8 }, (_, i) => mkTest({ status: "passed", full_title: `p${i}` })),
    ...Array.from({ length: 2 }, (_, i) => mkTest({ status: "pending", full_title: `pend${i}` })),
  ];
  const spec = mkSpec({
    tests,
    stats: { total: 10, passed: 8, failed: 0, skipped: 0, pending: 2, duration_ms: 100 },
  });
  const body = buildCommentBody(
    mkRun({ stats: { total: 10, passed: 8, failed: 0, skipped: 0, pending: 2 }, specs: [spec] }),
    1, URL, "", []
  );

  assert.ok(body.includes("| **Status** | Incomplete |"), `incomplete run must not read Passed: ${body}`);
  assert.ok(body.includes("⚠️"), "incomplete uses the warning icon, not the green check");
  assert.ok(!body.includes("✅"), "an incomplete run must never show the passing check");
  // The pending count is surfaced so the Incomplete status is explained.
  assert.ok(body.includes("| **Pending** | 2 |"), `pending row must appear: ${body}`);
});

test("a fully-accounted-for run (passed + skipped === total, no failures) is Passed", () => {
  const tests = [
    ...Array.from({ length: 7 }, (_, i) => mkTest({ status: "passed", full_title: `p${i}` })),
    ...Array.from({ length: 3 }, (_, i) => mkTest({ status: "skipped", full_title: `s${i}` })),
  ];
  const spec = mkSpec({
    tests,
    stats: { total: 10, passed: 7, failed: 0, skipped: 3, pending: 0, duration_ms: 100 },
  });
  const body = buildCommentBody(
    mkRun({ stats: { total: 10, passed: 7, failed: 0, skipped: 3, pending: 0 }, specs: [spec] }),
    1, URL, "", []
  );

  assert.ok(body.includes("| **Status** | Passed |"), `clean run should be Passed: ${body}`);
  assert.ok(body.includes("✅"), "passing icon");
  // No pending row when there are no pending tests (kept off the table).
  assert.ok(!body.includes("**Pending**"), "no pending row when pending is zero");
});

test("any failure wins over pending — failed run reads Failed even with pending tests", () => {
  const tests = [
    mkTest({ status: "failed", full_title: "broke", error: { message: "boom" } }),
    mkTest({ status: "pending", full_title: "never ran" }),
  ];
  const spec = mkSpec({
    tests,
    stats: { total: 2, passed: 0, failed: 1, skipped: 0, pending: 1, duration_ms: 5 },
  });
  const body = buildCommentBody(
    mkRun({ stats: { total: 2, passed: 0, failed: 1, skipped: 0, pending: 1 }, specs: [spec] }),
    1, URL, "", []
  );

  assert.ok(body.includes("| **Status** | Failed |"), `failure must take precedence: ${body}`);
  assert.ok(body.includes("❌"), "failing icon");
  // Pending still surfaced in the table.
  assert.ok(body.includes("| **Pending** | 1 |"), "pending row present alongside the failure");
});

// ── trend row is conditional ────────────────────────────────────────────

test("trend row appears only when a trend string is supplied", () => {
  const withTrend = buildCommentBody(mkRun(), 1, URL, "✅✅❌", []);
  assert.ok(withTrend.includes("| **Recent** |"), "trend row present when given");
  const without = buildCommentBody(mkRun(), 1, URL, "", []);
  assert.ok(!without.includes("| **Recent** |"), "no trend row when trend is empty");
});

// ── pass rate divide-by-zero guard ──────────────────────────────────────

test("zero-total run reports 0.0% pass rate, not NaN", () => {
  const spec = mkSpec({ tests: [], stats: { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, duration_ms: 0 } });
  const body = buildCommentBody(mkRun({ stats: { total: 0, passed: 0, failed: 0 }, specs: [spec] }), 1, URL, "", []);
  assert.ok(body.includes("| **Pass Rate** | 0.0% (0/0) |"), `expected 0.0% guard: ${body}`);
  assert.ok(!body.includes("NaN"), "never emit NaN");
});
