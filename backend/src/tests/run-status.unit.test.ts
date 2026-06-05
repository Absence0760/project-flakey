// Unit coverage for classifyRunStatus — the single classifier the badge and
// GET /runs/status both use. Pure function, no DB. The precedence here is the
// contract both signals depend on, so a regression that swaps two branches is
// the kind of thing this guards against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRunStatus, type RunStatusInput } from "../run-status.js";

// A clean, fully-accounted-for finished run. Spread + override per case.
const base: RunStatusInput = {
  failed: 0,
  aborted: false,
  finished_at: new Date(),
  total: 5,
  passed: 5,
  skipped: 0,
};

test("passed: finished, not aborted, zero failures, every test accounted for", () => {
  assert.equal(classifyRunStatus(base), "passed");
  // passed + skipped === total (intentional skips) is still a clean pass.
  assert.equal(classifyRunStatus({ ...base, passed: 3, skipped: 2 }), "passed");
  // finished_at as an ISO string (raw column) is still a pass.
  assert.equal(classifyRunStatus({ ...base, finished_at: "2026-06-05T00:00:00Z" }), "passed");
});

test("failed: any recorded failure on a finished run", () => {
  assert.equal(classifyRunStatus({ ...base, failed: 1, passed: 4 }), "failed");
});

test("aborted: killed mid-flight with no recorded failure", () => {
  // Aborted runs typically never merge, so finished_at is NULL — the abort
  // flag must still win over the incomplete branch.
  assert.equal(classifyRunStatus({ ...base, aborted: true, finished_at: null }), "aborted");
  // Even a finished-but-aborted run with no failures is "aborted", not "passed".
  assert.equal(classifyRunStatus({ ...base, aborted: true }), "aborted");
});

test("incomplete: live / partially-merged run that has not finished", () => {
  assert.equal(classifyRunStatus({ ...base, finished_at: null }), "incomplete");
});

test("incomplete: a finished run with pending tests (passed + skipped < total) is NOT a pass", () => {
  // 5 total, 4 passed, 0 skipped, 0 failed → 1 pending. Results incomplete, so
  // not a clean pass — this is the false-green case the classifier must catch.
  assert.equal(classifyRunStatus({ ...base, passed: 4, total: 5 }), "incomplete");
});

test("precedence: failed beats aborted beats incomplete", () => {
  // failed > 0 wins over an abort so the actionable failure count survives.
  assert.equal(classifyRunStatus({ ...base, failed: 2, aborted: true, finished_at: null }), "failed");
  // aborted wins over not-yet-finished.
  assert.equal(classifyRunStatus({ ...base, aborted: true, finished_at: null }), "aborted");
});

test("a not-yet-finished run with zero failures is never 'passed' (fails closed)", () => {
  assert.notEqual(
    classifyRunStatus({ ...base, finished_at: null }),
    "passed",
    "an in-progress run must not read as a pass",
  );
});
