/**
 * Mochawesome parser unit tests — Cypress's native report format.
 *
 * The parser drives most production data: every Cypress run that uses
 * mochawesome (the dominant Cypress reporter) flows through here.  Subtle
 * bugs here corrupt aggregate stats *silently* — they don't crash, they
 * just produce wrong numbers in dashboards and trend charts.
 *
 * Coverage targets the seams most likely to break:
 *  - empty / null payloads
 *  - deeply nested suites (Cypress's `describe` blocks nest arbitrarily)
 *  - hook failures (reported as test entries with `fail: true`)
 *  - tests directly on result vs nested in suites
 *  - status flag combinations (pending vs skipped vs neither)
 *  - duration corruption (NaN, negative, missing)
 *  - title/fullTitle fallback paths
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMochawesome } from "../normalizers/mochawesome.js";
import type { NormalizedRun } from "../types.js";

const META: NormalizedRun["meta"] = {
  suite_name: "smoke",
  branch: "main",
  commit_sha: "abc",
  ci_run_id: "",
  reporter: "mochawesome",
  started_at: "",
  finished_at: "",
  environment: "",
};

// ── Empty / null payloads ────────────────────────────────────────────────

test("parseMochawesome: empty object produces a valid run with zero stats", () => {
  const out = parseMochawesome({}, META);
  assert.equal(out.specs.length, 0);
  assert.equal(out.stats.total, 0);
  assert.equal(out.stats.passed, 0);
  assert.equal(out.stats.failed, 0);
  // started_at must be defaulted; the run insert NOT NULL constraint will
  // explode otherwise.
  assert.ok(out.meta.started_at, "started_at should default when stats.start absent");
  assert.ok(out.meta.finished_at);
});

test("parseMochawesome: results: [] produces zero specs", () => {
  const out = parseMochawesome({ results: [] }, META);
  assert.equal(out.specs.length, 0);
});

test("parseMochawesome: result with no suites and no tests produces an empty spec", () => {
  const out = parseMochawesome({
    results: [{ file: "empty.cy.ts", title: "Empty", suites: [], tests: [] }],
  }, META);
  assert.equal(out.specs.length, 1);
  assert.equal(out.specs[0].tests.length, 0);
  assert.equal(out.specs[0].file_path, "empty.cy.ts");
});

// ── Status flags ─────────────────────────────────────────────────────────

test("parseMochawesome: each status flag maps correctly", () => {
  const out = parseMochawesome({
    results: [{
      file: "status.cy.ts",
      suites: [{
        title: "S",
        tests: [
          { title: "p", pass: true, duration: 10 },
          { title: "f", fail: true, duration: 5, err: { message: "boom" } },
          { title: "pend", pending: true, duration: 0 },
          { title: "skip", skipped: true, duration: 0 },
        ],
      }],
    }],
  }, META);
  const tests = out.specs[0].tests;
  const byTitle = Object.fromEntries(tests.map((t) => [t.title, t.status]));
  assert.equal(byTitle.p, "passed");
  assert.equal(byTitle.f, "failed");
  assert.equal(byTitle.pend, "pending");
  assert.equal(byTitle.skip, "skipped");
});

test("parseMochawesome: test with NO status flags set is treated as skipped (current behaviour, document it)", () => {
  // This is a known quirk of getStatus: any test missing all of
  // pass/fail/pending/skipped falls through to "skipped".  Mochawesome
  // should never actually emit such tests, but if a corrupt report
  // arrives, we'd rather classify them clearly than silently call them
  // passed.  The test pins the current behaviour so future refactors
  // don't accidentally flip the default to "passed".
  const out = parseMochawesome({
    results: [{ file: "weird.cy.ts", suites: [{ tests: [{ title: "?" }] }] }],
  }, META);
  assert.equal(out.specs[0].tests[0].status, "skipped");
});

// ── Nested suites ────────────────────────────────────────────────────────

test("parseMochawesome: deeply nested suites are flattened with > separator", () => {
  // Cypress users nest describe blocks; the parser must walk all the way
  // down and synthesize fullTitle from the suite chain when the report
  // didn't include one.
  const out = parseMochawesome({
    results: [{
      file: "deep.cy.ts",
      suites: [{
        title: "Outer",
        tests: [],
        suites: [{
          title: "Mid",
          tests: [],
          suites: [{
            title: "Inner",
            tests: [{ title: "leaf", pass: true, duration: 1 }],
          }],
        }],
      }],
    }],
  }, META);
  const t = out.specs[0].tests[0];
  assert.equal(t.title, "leaf");
  assert.ok(t.full_title.includes("Outer"));
  assert.ok(t.full_title.includes("Mid"));
  assert.ok(t.full_title.includes("Inner"));
  assert.ok(t.full_title.includes("leaf"));
});

test("parseMochawesome: sibling suites are walked independently", () => {
  const out = parseMochawesome({
    results: [{
      file: "siblings.cy.ts",
      suites: [{
        title: "Root",
        tests: [],
        suites: [
          { title: "A", tests: [{ title: "a1", pass: true, duration: 1 }] },
          { title: "B", tests: [{ title: "b1", pass: true, duration: 1 }] },
          { title: "C", tests: [{ title: "c1", fail: true, duration: 1, err: { message: "x" } }] },
        ],
      }],
    }],
  }, META);
  const tests = out.specs[0].tests;
  assert.equal(tests.length, 3, "all sibling-suite tests should be collected");
  assert.equal(out.specs[0].stats.passed, 2);
  assert.equal(out.specs[0].stats.failed, 1);
});

// ── Hook failures ────────────────────────────────────────────────────────

test("parseMochawesome: hook failure (before each) is surfaced as a failed test", () => {
  // When Cypress's `beforeEach` hook throws, mochawesome inserts a
  // synthetic test entry like `"before each" hook for "real test"` with
  // fail: true.  These must be captured — they're the most common cause
  // of a green-then-red flaky pattern in CI.
  const out = parseMochawesome({
    results: [{
      file: "hook.cy.ts",
      suites: [{
        title: "S",
        tests: [
          {
            title: '"before each" hook for "should work"',
            fullTitle: 'S "before each" hook for "should work"',
            fail: true,
            duration: 0,
            err: { message: "TypeError: foo is not defined" },
          },
        ],
      }],
    }],
  }, META);
  assert.equal(out.specs[0].stats.failed, 1, "hook failure should count as 1 failed test");
  assert.ok(out.specs[0].tests[0].error?.message?.includes("TypeError"));
});

test("parseMochawesome: 3-level nesting with a failing beforeEach hook keeps the full ancestor path and counts both the hook and the real test", () => {
  // Client workflow: a Cypress spec nests describe blocks 3 deep and the
  // innermost `beforeEach` throws.  Mochawesome emits a synthetic hook
  // entry (fail: true) ALONGSIDE the real test (which Cypress marks as
  // failed/skipped).  Both must survive normalization, the synthesized
  // full_title for entries lacking fullTitle must include every ancestor
  // (Outer > Mid > Inner > …), and nothing may be double-counted.
  const out = parseMochawesome({
    results: [{
      file: "nested-hook.cy.ts",
      suites: [{
        title: "Outer",
        tests: [],
        suites: [{
          title: "Mid",
          tests: [],
          suites: [{
            title: "Inner",
            tests: [
              // Synthetic hook entry — note: no fullTitle, so the parser
              // must synthesize it from the suite chain.
              {
                title: '"before each" hook for "loads dashboard"',
                fail: true,
                duration: 0,
                err: { message: "TypeError: cy.login is not a function" },
              },
              // The real test that the hook was guarding.
              {
                title: "loads dashboard",
                fail: true,
                duration: 12,
                err: { message: "TypeError: cy.login is not a function" },
              },
            ],
          }],
        }],
      }],
    }],
  }, META);

  const tests = out.specs[0].tests;
  assert.equal(tests.length, 2, "both the hook entry and the real test must be present");

  const hook = tests.find((t) => t.title.includes("before each"))!;
  const real = tests.find((t) => t.title === "loads dashboard")!;
  assert.ok(hook, "hook entry should not be dropped");
  assert.ok(real, "real test should not be dropped");

  // Full ancestor path synthesized from the suite chain for BOTH entries.
  for (const t of [hook, real]) {
    assert.ok(t.full_title.includes("Outer"), `${t.title}: missing Outer ancestor`);
    assert.ok(t.full_title.includes("Mid"), `${t.title}: missing Mid ancestor`);
    assert.ok(t.full_title.includes("Inner"), `${t.title}: missing Inner ancestor`);
  }
  assert.ok(real.full_title.endsWith("loads dashboard"));

  // Neither dropped nor double-counted: exactly 2 failures, no extras.
  assert.equal(out.specs[0].stats.failed, 2, "hook + real test = 2 failed, no double-count");
  assert.equal(out.specs[0].stats.total, 2);
  assert.equal(out.stats.failed, 2, "run-level failed rolls up to exactly 2");
  assert.equal(out.stats.total, 2);
});

test("parseMochawesome: hook failures in different nested suites are counted separately", () => {
  // Two independent beforeEach failures in two sibling sub-suites under a
  // shared root.  Each must be collected with its own correct ancestor
  // path and counted independently — a flattening bug that reused the
  // wrong suite chain or collapsed siblings would lose one.
  const out = parseMochawesome({
    results: [{
      file: "two-hooks.cy.ts",
      suites: [{
        title: "Root",
        tests: [],
        suites: [
          {
            title: "Auth",
            tests: [{
              title: '"before each" hook for "logs in"',
              fail: true,
              duration: 0,
              err: { message: "AuthError: missing token" },
            }],
          },
          {
            title: "Billing",
            tests: [{
              title: '"before each" hook for "renders invoice"',
              fail: true,
              duration: 0,
              err: { message: "BillingError: no subscription" },
            }],
          },
        ],
      }],
    }],
  }, META);

  const tests = out.specs[0].tests;
  assert.equal(tests.length, 2, "both hook failures must be present");
  assert.equal(out.specs[0].stats.failed, 2, "two hook failures counted separately");

  const auth = tests.find((t) => t.error?.message?.includes("AuthError"))!;
  const billing = tests.find((t) => t.error?.message?.includes("BillingError"))!;
  assert.ok(auth, "Auth-suite hook failure present");
  assert.ok(billing, "Billing-suite hook failure present");

  // Each carries its own distinct ancestor path — no cross-contamination.
  assert.ok(auth.full_title.includes("Root"));
  assert.ok(auth.full_title.includes("Auth"));
  assert.ok(!auth.full_title.includes("Billing"), "Auth hook must not pick up the Billing suite");
  assert.ok(billing.full_title.includes("Root"));
  assert.ok(billing.full_title.includes("Billing"));
  assert.ok(!billing.full_title.includes("Auth"), "Billing hook must not pick up the Auth suite");
});

// ── Run-level vs spec-level pending aggregation ──────────────────────────

test("parseMochawesome: run.pending reads raw stats.pending even when it disagrees with per-test pending counts", () => {
  // Documented seam: spec-level pending is computed from per-test statuses,
  // but run-level pending is taken verbatim from raw stats.pending (mirroring
  // how the runs table has always tracked the reporter's own pending count).
  // When the reporter's stats.pending disagrees with the test bodies, the run
  // total trusts stats.pending — pin that so a refactor doesn't silently swap
  // to summing spec pending.
  const out = parseMochawesome({
    results: [{
      file: "pending-disagree.cy.ts",
      suites: [{
        tests: [
          { title: "p1", pending: true },
          { title: "p2", pending: true },
          { title: "ok", pass: true, duration: 1 },
        ],
      }],
    }],
    // Reporter claims only 1 pending, but two test bodies are pending.
    stats: { pending: 1 },
  }, META);

  assert.equal(out.specs[0].stats.pending, 2, "spec pending counts the actual pending test bodies");
  assert.equal(out.stats.pending, 1, "run pending trusts raw stats.pending verbatim");
});

test("parseMochawesome: run.pending is 0 when stats.pending is absent, even with pending tests", () => {
  // When the reporter omits stats.pending entirely, run-level pending
  // defaults to 0 — the per-spec pending counts still reflect reality, so
  // this is a known asymmetry, not silent data loss at the spec level.
  const out = parseMochawesome({
    results: [{
      file: "pending-absent.cy.ts",
      suites: [{
        tests: [
          { title: "p1", pending: true },
          { title: "ok", pass: true, duration: 1 },
        ],
      }],
    }],
    // No stats.pending key at all.
    stats: { passes: 1 },
  }, META);

  assert.equal(out.specs[0].stats.pending, 1, "spec pending still counts pending test bodies");
  assert.equal(out.stats.pending, 0, "run pending defaults to 0 when stats.pending is absent");
});

test("parseMochawesome: run.pending honors a present stats.pending that matches the test bodies", () => {
  const out = parseMochawesome({
    results: [{
      file: "pending-consistent.cy.ts",
      suites: [{
        tests: [
          { title: "p1", pending: true },
          { title: "p2", pending: true },
          { title: "ok", pass: true, duration: 1 },
        ],
      }],
    }],
    stats: { pending: 2 },
  }, META);

  assert.equal(out.specs[0].stats.pending, 2);
  assert.equal(out.stats.pending, 2, "run pending reflects the consistent raw stats.pending");
});

// ── Tests directly on result (no enclosing suite) ────────────────────────

test("parseMochawesome: tests on result.tests (no suite) are included", () => {
  // Rare but legal mochawesome shape — Mocha reporters sometimes attach
  // file-level tests directly when there's no `describe()` wrapper.
  const out = parseMochawesome({
    results: [{
      file: "loose.cy.ts",
      tests: [{ title: "loose", pass: true, duration: 1 }],
      suites: [],
    }],
  }, META);
  assert.equal(out.specs[0].tests.length, 1);
  assert.equal(out.specs[0].tests[0].title, "loose");
});

test("parseMochawesome: result with both result.tests and suites collects both", () => {
  const out = parseMochawesome({
    results: [{
      file: "mixed.cy.ts",
      tests: [{ title: "loose", pass: true, duration: 1 }],
      suites: [{ title: "S", tests: [{ title: "nested", pass: true, duration: 1 }] }],
    }],
  }, META);
  assert.equal(out.specs[0].tests.length, 2, "both loose and nested tests should be collected");
});

// ── Duration handling ────────────────────────────────────────────────────

test("parseMochawesome: missing duration coerces to 0", () => {
  const out = parseMochawesome({
    results: [{
      file: "no-dur.cy.ts",
      suites: [{ tests: [{ title: "x", pass: true }] }],
    }],
  }, META);
  assert.equal(out.specs[0].tests[0].duration_ms, 0);
  assert.equal(out.specs[0].stats.duration_ms, 0);
});

test("parseMochawesome: NaN duration does NOT corrupt aggregate totals", () => {
  // Defensive: a NaN duration in a single test would otherwise propagate
  // to spec.stats.duration_ms and run.stats.duration_ms via reduce(),
  // breaking dashboards and trend charts (NaN-tainted columns aren't
  // sortable in Postgres).  Pinning expected behaviour: NaN must not
  // poison the sums.
  const out = parseMochawesome({
    results: [{
      file: "nan-dur.cy.ts",
      suites: [{
        tests: [
          { title: "ok", pass: true, duration: 100 },
          { title: "nan", pass: true, duration: NaN },
        ],
      }],
    }],
  }, META);
  // Verify the spec total isn't NaN — it would silently corrupt the run.
  assert.ok(
    Number.isFinite(out.specs[0].stats.duration_ms),
    `spec duration_ms became ${out.specs[0].stats.duration_ms} (NaN would break SQL ints)`
  );
  assert.ok(Number.isFinite(out.stats.duration_ms), "run duration_ms must be finite");
});

// ── Title fallbacks ──────────────────────────────────────────────────────

test("parseMochawesome: missing test.title falls back to empty string", () => {
  const out = parseMochawesome({
    results: [{ file: "f.cy.ts", suites: [{ title: "S", tests: [{ pass: true }] }] }],
  }, META);
  assert.equal(out.specs[0].tests[0].title, "");
});

test("parseMochawesome: spec title falls back to file path when result.title missing", () => {
  const out = parseMochawesome({
    results: [{ file: "fallback.cy.ts", suites: [] }],
  }, META);
  assert.equal(out.specs[0].title, "fallback.cy.ts");
});

test("parseMochawesome: file_path uses result.file or result.fullFile", () => {
  const a = parseMochawesome({
    results: [{ file: "a.cy.ts", suites: [] }],
  }, META);
  const b = parseMochawesome({
    results: [{ fullFile: "/abs/path/b.cy.ts", suites: [] }],
  }, META);
  assert.equal(a.specs[0].file_path, "a.cy.ts");
  assert.equal(b.specs[0].file_path, "/abs/path/b.cy.ts");
});

// ── Errors ───────────────────────────────────────────────────────────────

test("parseMochawesome: error message + estack are both captured", () => {
  const out = parseMochawesome({
    results: [{
      file: "err.cy.ts",
      suites: [{
        tests: [{
          title: "x", fail: true, duration: 1,
          err: { message: "AssertionError: x !== y", estack: "AssertionError: x\n  at line 5" },
        }],
      }],
    }],
  }, META);
  const t = out.specs[0].tests[0];
  assert.ok(t.error);
  assert.ok(t.error!.message.includes("AssertionError"));
  assert.ok(t.error!.stack?.includes("at line 5"));
});

test("parseMochawesome: failed test with no err.message has no error field", () => {
  // Edge: malformed report, fail:true but no message.  Without a guard
  // we'd construct {message: undefined, stack: undefined} which hits the
  // DB as NULL but with a non-null wrapping object.  Pinning: error stays
  // undefined unless there's a real message.
  const out = parseMochawesome({
    results: [{
      file: "noerr.cy.ts",
      suites: [{ tests: [{ title: "x", fail: true, duration: 1 }] }],
    }],
  }, META);
  assert.equal(out.specs[0].tests[0].error, undefined);
});

// ── Aggregation correctness ──────────────────────────────────────────────

test("parseMochawesome: spec.stats reflects only that spec's tests", () => {
  // Common bug: aggregating across all specs into per-spec counts.  Each
  // result must produce a spec whose stats describe only its own tests.
  const out = parseMochawesome({
    results: [
      {
        file: "a.cy.ts",
        suites: [{ tests: [
          { title: "1", pass: true, duration: 1 },
          { title: "2", fail: true, duration: 1, err: { message: "x" } },
        ] }],
      },
      {
        file: "b.cy.ts",
        suites: [{ tests: [
          { title: "3", pass: true, duration: 1 },
          { title: "4", pass: true, duration: 1 },
        ] }],
      },
    ],
  }, META);
  assert.equal(out.specs[0].stats.passed, 1);
  assert.equal(out.specs[0].stats.failed, 1);
  assert.equal(out.specs[1].stats.passed, 2);
  assert.equal(out.specs[1].stats.failed, 0);
  // Run-level rolls up across specs
  assert.equal(out.stats.passed, 3);
  assert.equal(out.stats.failed, 1);
  assert.equal(out.stats.total, 4);
});

test("parseMochawesome: skipped and pending are disjoint at the spec level", () => {
  // Skipped and pending are tracked as separate, non-overlapping counts at
  // both spec and run level (mirroring how runs has always tracked pending),
  // so passed + failed + skipped + pending === total holds at every level.
  const out = parseMochawesome({
    results: [{
      file: "s.cy.ts",
      suites: [{
        tests: [
          { title: "p", pending: true },
          { title: "s", skipped: true },
          { title: "ok", pass: true, duration: 1 },
        ],
      }],
    }],
    stats: { pending: 1 },
  }, META);
  assert.equal(out.specs[0].stats.skipped, 1, "spec.skipped counts only skipped tests");
  assert.equal(out.specs[0].stats.pending, 1, "spec.pending counts only pending tests");
  assert.equal(out.stats.pending, 1, "run.pending reads from raw stats.pending");
  const s = out.specs[0].stats;
  assert.equal(s.passed + s.failed + s.skipped + s.pending, s.total, "spec counts sum to total");
});

// ── Stress ───────────────────────────────────────────────────────────────

test("parseMochawesome: 1000-test report parses in well under 1s", () => {
  const tests = Array.from({ length: 1000 }, (_, i) => ({
    title: `t${i}`, pass: true, duration: i,
  }));
  const start = Date.now();
  const out = parseMochawesome({
    results: [{ file: "big.cy.ts", suites: [{ title: "S", tests }] }],
  }, META);
  const dur = Date.now() - start;
  assert.equal(out.stats.total, 1000);
  assert.ok(dur < 1000, `1000-test parse took ${dur}ms`);
});
