/**
 * Unit coverage for the coverage-gate status content (coverageStatusContent /
 * formatCoveragePct in src/integrations/coverage-gate.ts).
 *
 * The gate posts a commit status whose `state` is the exact `linesPct >=
 * threshold` decision and whose `description` shows the percentage. The
 * description used `toFixed(1)`, which rounds half-up — so a run at 79.96%
 * against an 80% threshold correctly *failed* but rendered "Coverage 80.0% <
 * 80%", a self-contradiction. These tests pin the invariant the fix restores:
 * the displayed number, compared to the threshold, must always agree with the
 * gate state — while the gate decision itself stays exact (no loosening).
 *
 * Pure functions, no DB. Run:
 *   node --import tsx --test src/tests/coverage_gate.unit.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageStatusContent, formatCoveragePct } from "../integrations/coverage-gate.js";

test("clear pass: well above threshold", () => {
  const { state, description } = coverageStatusContent(92.5, 80);
  assert.equal(state, "success");
  assert.equal(description, "Coverage 92.5% ≥ 80%");
});

test("clear fail: well below threshold", () => {
  const { state, description } = coverageStatusContent(60, 80);
  assert.equal(state, "failure");
  assert.equal(description, "Coverage 60.0% < 80%");
});

test("exactly at threshold is a pass (>=)", () => {
  const { state, description } = coverageStatusContent(80, 80);
  assert.equal(state, "success");
  assert.equal(description, "Coverage 80.0% ≥ 80%");
});

test("the bug case: 79.96 vs 80 fails AND the display never reads '80.0% < 80%'", () => {
  const { state, description } = coverageStatusContent(79.96, 80);
  assert.equal(state, "failure", "79.96 < 80 → the gate must fail");
  // toFixed(1) would have produced the contradictory "Coverage 80.0% < 80%".
  // The fix widens precision so the shown number stays below the threshold.
  assert.equal(description, "Coverage 79.96% < 80%");
});

test("just above an integer threshold still rounds cleanly when it stays a pass", () => {
  const { state, description } = coverageStatusContent(80.04, 80);
  assert.equal(state, "success");
  assert.equal(description, "Coverage 80.0% ≥ 80%");
});

test("fractional threshold, pass: 1-decimal display stays >= threshold", () => {
  // 79.96 >= 79.95 → pass. Shown "80.0" is still ≥ 79.95, so consistent.
  const { state, description } = coverageStatusContent(79.96, 79.95);
  assert.equal(state, "success");
  assert.equal(description, "Coverage 80.0% ≥ 79.95%");
});

test("fractional threshold, fail: display stays strictly below threshold", () => {
  // 79.94 < 79.95 → fail. Shown "79.9" is < 79.95, so consistent.
  const { state, description } = coverageStatusContent(79.94, 79.95);
  assert.equal(state, "failure");
  assert.equal(description, "Coverage 79.9% < 79.95%");
});

test("within rounding distance of the threshold: falls back to direction-safe rounding", () => {
  // 80 - 1e-7 rounds to "80.000000" at every precision up to 6 dp, so the
  // loop can't find a consistent display — the fallback floors it below 80.
  const pct = 80 - 1e-7;
  const { state, description } = coverageStatusContent(pct, 80);
  assert.equal(state, "failure", "strictly below 80 → fail");
  const shown = Number(/Coverage ([\d.]+)%/.exec(description)![1]);
  assert.ok(shown < 80, `displayed ${shown} must stay below the threshold, not round up to 80`);
});

test("invariant: across many values, displayed number vs threshold always agrees with state", () => {
  const thresholds = [0, 50, 79.95, 80, 90, 99.9, 100];
  for (const threshold of thresholds) {
    for (let pct = 0; pct <= 100; pct += 0.01) {
      const rounded = Math.round(pct * 100) / 100; // avoid float drift in the loop counter
      const { state, description } = coverageStatusContent(rounded, threshold);
      // State must reflect the EXACT comparison (gate is not loosened).
      assert.equal(
        state,
        rounded >= threshold ? "success" : "failure",
        `state for ${rounded} vs ${threshold} must be exact`,
      );
      // The DISPLAYED number must land on the same side of the threshold.
      const shown = Number(/Coverage ([\d.]+)%/.exec(description)![1]);
      if (state === "success") {
        assert.ok(shown >= threshold, `pass: shown ${shown} must be ≥ ${threshold} (was "${description}")`);
      } else {
        assert.ok(shown < threshold, `fail: shown ${shown} must be < ${threshold} (was "${description}")`);
      }
    }
  }
});

test("formatCoveragePct: returns one decimal in the common case", () => {
  assert.equal(formatCoveragePct(85.5, 80, true), "85.5");
  assert.equal(formatCoveragePct(72.3, 80, false), "72.3");
});
