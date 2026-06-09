/**
 * Flaky-analysis flip-count unit tests.
 *
 * countFlips() turns a chronological pass/fail timeline into the number of
 * adjacent status changes ("flips"). It's the core of the flaky signal: both
 * GET /flaky and the flaky.detected webhook (>= 2 flips) gate on it, so a
 * regression here silently changes which tests are classified flaky. It's a
 * pure function over a string[] with no external deps — these pin its contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countFlips } from "../flaky-analysis.js";

test("countFlips: empty timeline → 0", () => {
  assert.equal(countFlips([]), 0);
});

test("countFlips: single result → 0 (no adjacent pair)", () => {
  assert.equal(countFlips(["passed"]), 0);
});

test("countFlips: all same status → 0", () => {
  assert.equal(countFlips(["passed", "passed", "passed"]), 0);
  assert.equal(countFlips(["failed", "failed"]), 0);
});

test("countFlips: one transition → 1", () => {
  assert.equal(countFlips(["passed", "failed"]), 1);
  assert.equal(countFlips(["failed", "passed"]), 1);
});

test("countFlips: alternating P/F/P/F counts every transition", () => {
  assert.equal(countFlips(["passed", "failed", "passed", "failed"]), 3);
});

test("countFlips: runs of repeats only count the boundaries", () => {
  // P P F F P  → one P→F flip, one F→P flip = 2
  assert.equal(countFlips(["passed", "passed", "failed", "failed", "passed"]), 2);
});

test("countFlips: a single fail amid passes (just under the >=2 webhook gate) → 2", () => {
  // P P F P → P→F then F→P = 2 flips: exactly the flaky.detected threshold.
  assert.equal(countFlips(["passed", "passed", "failed", "passed"]), 2);
});
