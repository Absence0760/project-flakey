/**
 * WebdriverIO parser unit tests.
 *
 * Coverage for parseWebdriverIO() — handles WDIO JSON reporter uploads
 * (CLI/curl path; the direct reporter plugin bypasses this).  Targets the
 * real client workflow: nested suites + hooks must yield tests with correct
 * nested full_titles, and hook entries must be ignored.
 *   - suite.tests extracted; suite.hooks ignored.
 *   - 3-level nested suites: full_title preserves every ancestor.
 *   - suite with no direct tests but nested suites: recursion returns them.
 *   - empty nested suite: zero tests, no crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebdriverIO } from "../normalizers/webdriverio.js";
import type { NormalizedRun } from "../types.js";

const META: NormalizedRun["meta"] = {
  suite_name: "smoke",
  branch: "main",
  commit_sha: "abc",
  ci_run_id: "",
  reporter: "webdriverio",
  started_at: "",
  finished_at: "",
  environment: "",
};

// ── Hooks ignored ──────────────────────────────────────────────────────────

test("parseWebdriverIO: suite tests are extracted while hooks are ignored", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "Login flow",
      file: "login.e2e.ts",
      hooks: [
        { name: "\"before each\" hook", state: "passed", duration: 5 },
        { name: "\"after all\" hook", state: "passed", duration: 3 },
      ],
      tests: [
        { name: "logs in", state: "passed", duration: 100 },
        { name: "rejects bad password", state: "failed", duration: 50 },
      ],
    }],
  } as any, META);

  assert.equal(out.specs.length, 1);
  const titles = out.specs[0].tests.map((t) => t.title);
  // Exactly the two real tests — no hook entries leaked in.
  assert.deepEqual(titles.sort(), ["logs in", "rejects bad password"]);
  assert.equal(out.stats.total, 2);
  assert.equal(out.stats.passed, 1);
  assert.equal(out.stats.failed, 1);
});

// ── Nested full_title ────────────────────────────────────────────────────────

test("parseWebdriverIO: 3-level nested suites preserve all ancestors in full_title", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "Checkout",
      file: "checkout.e2e.ts",
      tests: [],
      suites: [{
        name: "Payment",
        tests: [],
        suites: [{
          name: "Credit card",
          tests: [
            { name: "declines expired card", state: "failed", duration: 20 },
          ],
        }],
      }],
    }],
  } as any, META);

  const t = out.specs[0].tests[0];
  assert.equal(
    t.full_title,
    "Checkout > Payment > Credit card > declines expired card",
    "full_title must chain every ancestor suite name"
  );
  assert.equal(out.stats.total, 1);
});

test("parseWebdriverIO: explicit test.fullTitle overrides the derived nested prefix", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "Outer",
      file: "o.e2e.ts",
      tests: [
        { name: "leaf", fullTitle: "Custom > Provided > leaf", state: "passed", duration: 1 },
      ],
    }],
  } as any, META);
  assert.equal(out.specs[0].tests[0].full_title, "Custom > Provided > leaf");
});

// ── Recursion through suites with no direct tests ────────────────────────────

test("parseWebdriverIO: suite with no direct tests but nested suites still returns nested tests", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "Container",
      file: "container.e2e.ts",
      tests: [],
      suites: [
        { name: "Group A", tests: [{ name: "a1", state: "passed", duration: 1 }] },
        { name: "Group B", tests: [{ name: "b1", state: "skipped", duration: 0 }] },
      ],
    }],
  } as any, META);

  assert.equal(out.specs[0].tests.length, 2);
  const byTitle = Object.fromEntries(out.specs[0].tests.map((t) => [t.title, t.full_title]));
  assert.equal(byTitle["a1"], "Container > Group A > a1");
  assert.equal(byTitle["b1"], "Container > Group B > b1");
  assert.equal(out.stats.passed, 1);
  assert.equal(out.stats.skipped, 1);
});

// ── Empty nested suite ───────────────────────────────────────────────────────

test("parseWebdriverIO: empty nested suite yields zero tests and does not crash", () => {
  let out!: NormalizedRun;
  assert.doesNotThrow(() => {
    out = parseWebdriverIO({
      suites: [{
        name: "Empty container",
        file: "empty.e2e.ts",
        tests: [],
        suites: [
          { name: "Nothing here", tests: [], suites: [] },
        ],
      }],
    } as any, META);
  });
  assert.equal(out.specs.length, 1);
  assert.equal(out.specs[0].tests.length, 0);
  assert.equal(out.stats.total, 0);
  // finished_at must be a representable ISO string for the Postgres write.
  assert.doesNotThrow(() => new Date(out.meta.finished_at).toISOString());
});

// ── Duration coercion: never propagate a negative/NaN/string duration ───────
// Regression: webdriverio used a bare `?? 0`, which only guards null/undefined.
// A negative duration (clock skew) or a stringified number would flow into the
// summed spec/run totals — a negative run duration, or string concatenation.
// safeDuration (shared with mochawesome/playwright) clamps these to 0.

test("parseWebdriverIO: a negative test duration is clamped, not summed into a negative total", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "S", file: "s.e2e.ts",
      tests: [
        { name: "a", state: "passed", duration: 100 },
        { name: "b", state: "failed", duration: -5000 },
      ],
    }],
  } as any, META);
  assert.ok(out.stats.duration_ms >= 0, `run duration must not go negative, got ${out.stats.duration_ms}`);
  assert.equal(out.specs[0].tests[1].duration_ms, 0, "a negative duration is clamped to 0");
});

test("parseWebdriverIO: a stringified duration is coerced to a number, not concatenated", () => {
  const out = parseWebdriverIO({
    suites: [{
      name: "S", file: "s.e2e.ts",
      tests: [
        { name: "a", state: "passed", duration: "100" },
        { name: "b", state: "passed", duration: "200" },
      ],
    }],
  } as any, META);
  // Bare `?? 0` would leave strings → reduce concatenates ("0100200"); safeDuration coerces.
  assert.equal(typeof out.stats.duration_ms, "number");
  assert.equal(out.specs[0].stats.duration_ms, 300, "string durations are summed numerically");
});
