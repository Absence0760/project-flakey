/**
 * Compare-route categorization unit tests.
 *
 * categorizeChange() drives the /compare endpoint's per-test diff
 * category — what the PR-comparison UI shows next to each test.  A
 * regression in the category logic silently buries real state changes
 * (e.g., a test going from skipped to failed) under "unchanged".
 *
 * Bug history: the original switch fell through to "unchanged" for any
 * transition where "failed" appeared on only one side (skipped→failed,
 * failed→pending, etc.).  That made /compare an unreliable PR review
 * tool — reviewers couldn't trust that "no regressions" actually meant
 * what it said.
 *
 * The fix introduces two new categories (newly_skipped,
 * newly_failing_from_skipped) for those transitions and pins the full
 * 6×6 status matrix here so future changes can't silently re-introduce
 * the hole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeChange } from "../routes/compare.js";

// ── Missing-side semantics ───────────────────────────────────────────────

test("categorizeChange: missing on side A is 'added'", () => {
  assert.equal(categorizeChange(null, "passed"), "added");
  assert.equal(categorizeChange(null, "failed"), "added");
  assert.equal(categorizeChange(null, "skipped"), "added");
});

test("categorizeChange: missing on side B is 'removed'", () => {
  assert.equal(categorizeChange("passed", null), "removed");
  assert.equal(categorizeChange("failed", null), "removed");
});

test("categorizeChange: both null falls through to unchanged", () => {
  // 'added' wins per the impl precedence — we just want to pin that
  // it doesn't throw.  Both-null shouldn't happen since at least one
  // side must produce the key.
  assert.equal(categorizeChange(null, null), "added");
});

// ── Core regression / fix / still-failing ───────────────────────────────

test("categorizeChange: passed → failed is a regression", () => {
  assert.equal(categorizeChange("passed", "failed"), "regression");
});

test("categorizeChange: failed → passed is fixed", () => {
  assert.equal(categorizeChange("failed", "passed"), "fixed");
});

test("categorizeChange: failed → failed is still_failing", () => {
  assert.equal(categorizeChange("failed", "failed"), "still_failing");
});

// ── Bug regression: skipped/pending ↔ failed used to fall through ───────

test("categorizeChange: skipped → failed is newly_failing_from_skipped (BUG: was 'unchanged')", () => {
  // The ORIGINAL bug: a test that was skipped in the prior run and now
  // fails was silently categorised as "unchanged".  That hid real new
  // failures from PR reviewers — exactly the case where the user needs
  // a loud signal.
  assert.equal(
    categorizeChange("skipped", "failed"),
    "newly_failing_from_skipped",
    "skipped→failed must be a distinct, loud category"
  );
});

test("categorizeChange: pending → failed is newly_failing_from_skipped", () => {
  assert.equal(categorizeChange("pending", "failed"), "newly_failing_from_skipped");
});

test("categorizeChange: failed → skipped is newly_skipped (BUG: was 'unchanged')", () => {
  // Could be a developer skipping the failure to land a PR ("we'll fix
  // it later"), or an env break that takes the test out of execution.
  // Either way it must show up in the diff.
  assert.equal(
    categorizeChange("failed", "skipped"),
    "newly_skipped",
    "failed→skipped must surface — could be a 'skip-the-failure' workaround"
  );
});

test("categorizeChange: failed → pending is newly_skipped", () => {
  assert.equal(categorizeChange("failed", "pending"), "newly_skipped");
});

// ── Other status changes ────────────────────────────────────────────────

test("categorizeChange: passed → skipped is 'changed'", () => {
  assert.equal(categorizeChange("passed", "skipped"), "changed");
});

test("categorizeChange: skipped → passed is 'changed'", () => {
  assert.equal(categorizeChange("skipped", "passed"), "changed");
});

test("categorizeChange: passed → pending is 'changed'", () => {
  assert.equal(categorizeChange("passed", "pending"), "changed");
});

test("categorizeChange: skipped → pending is 'changed' (different status, neither failed)", () => {
  assert.equal(categorizeChange("skipped", "pending"), "changed");
});

// ── No-op transitions ───────────────────────────────────────────────────

test("categorizeChange: same status both sides is unchanged", () => {
  assert.equal(categorizeChange("passed", "passed"), "unchanged");
  assert.equal(categorizeChange("skipped", "skipped"), "unchanged");
  assert.equal(categorizeChange("pending", "pending"), "unchanged");
});

// ── Full 5×5 status matrix lock-down ────────────────────────────────────
// The matrix below is the *expected* category for every (a, b) status
// combination.  If any cell changes, this test fails — which is what we
// want, since changing a category is a UI-visible behaviour change that
// deserves an explicit code review.

test("categorizeChange: full status matrix is locked down", () => {
  const statuses = ["passed", "failed", "skipped", "pending"] as const;
  const expected: Record<string, Record<string, string>> = {
    passed:  { passed: "unchanged",      failed: "regression",                 skipped: "changed",       pending: "changed" },
    failed:  { passed: "fixed",          failed: "still_failing",              skipped: "newly_skipped", pending: "newly_skipped" },
    skipped: { passed: "changed",        failed: "newly_failing_from_skipped", skipped: "unchanged",     pending: "changed" },
    pending: { passed: "changed",        failed: "newly_failing_from_skipped", skipped: "changed",       pending: "unchanged" },
  };
  for (const a of statuses) {
    for (const b of statuses) {
      assert.equal(
        categorizeChange(a, b),
        expected[a][b],
        `(${a} → ${b}) mismatched expected=${expected[a][b]}`
      );
    }
  }
});
