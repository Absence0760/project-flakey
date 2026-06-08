/**
 * Auto-create failure selection + cap accounting.
 *
 * selectFailuresForAutoCreate is the pure decision behind autoCreateIssuesForRun:
 * which failed tests get a Jira ticket, and how many were dropped past the cap.
 * The cap exists so a catastrophic run can't fan out into hundreds of
 * ticket-creating HTTP calls; the `dropped` count is what lets the caller log a
 * truncation instead of silently losing tickets (guard rail: no silent caps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectFailuresForAutoCreate,
  MAX_AUTO_CREATE_ISSUES,
} from "../integrations/jira.js";
import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

function mkTest(over: Partial<NormalizedTest> = {}): NormalizedTest {
  return {
    title: "t",
    full_title: "Suite > t",
    status: "failed",
    duration_ms: 1,
    screenshot_paths: [],
    ...over,
  };
}

function mkRun(specs: NormalizedSpec[]): NormalizedRun {
  return {
    meta: {
      suite_name: "S", branch: "main", commit_sha: "c", ci_run_id: "1",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z", reporter: "playwright",
    },
    stats: { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, duration_ms: 0 },
    specs,
  };
}

function specWith(tests: NormalizedTest[]): NormalizedSpec {
  return {
    file_path: "tests/a.spec.ts",
    title: "a.spec.ts",
    stats: { total: tests.length, passed: 0, failed: tests.length, skipped: 0, pending: 0, duration_ms: 1 },
    tests,
  };
}

test("selects only failed tests, ignoring passed/skipped/pending", () => {
  const run = mkRun([
    specWith([
      mkTest({ status: "failed", full_title: "f1" }),
      mkTest({ status: "passed", full_title: "p1" }),
      mkTest({ status: "skipped", full_title: "s1" }),
      mkTest({ status: "pending", full_title: "pe1" }),
      mkTest({ status: "failed", full_title: "f2" }),
    ]),
  ]);
  const { selected, dropped } = selectFailuresForAutoCreate(run);
  assert.equal(selected.length, 2, "two failed tests selected");
  assert.deepEqual(selected.map((s) => s.test.full_title), ["f1", "f2"]);
  assert.equal(dropped, 0, "nothing dropped under the cap");
});

test("flattens failures across multiple specs, preserving order", () => {
  const run = mkRun([
    specWith([mkTest({ full_title: "a-f1" })]),
    specWith([mkTest({ full_title: "b-f1" }), mkTest({ full_title: "b-f2" })]),
  ]);
  const { selected } = selectFailuresForAutoCreate(run);
  assert.deepEqual(selected.map((s) => s.test.full_title), ["a-f1", "b-f1", "b-f2"]);
});

test("caps at MAX_AUTO_CREATE_ISSUES and reports the dropped remainder", () => {
  const failures = Array.from({ length: MAX_AUTO_CREATE_ISSUES + 7 }, (_, i) =>
    mkTest({ full_title: `f${i}` })
  );
  const run = mkRun([specWith(failures)]);
  const { selected, dropped } = selectFailuresForAutoCreate(run);
  assert.equal(selected.length, MAX_AUTO_CREATE_ISSUES, "selection is capped");
  assert.equal(dropped, 7, "the remainder beyond the cap is reported, not silently lost");
  // The cap takes the first N in order.
  assert.equal(selected.at(-1)!.test.full_title, `f${MAX_AUTO_CREATE_ISSUES - 1}`);
});

test("exactly at the cap drops nothing", () => {
  const failures = Array.from({ length: MAX_AUTO_CREATE_ISSUES }, (_, i) => mkTest({ full_title: `f${i}` }));
  const { selected, dropped } = selectFailuresForAutoCreate(mkRun([specWith(failures)]));
  assert.equal(selected.length, MAX_AUTO_CREATE_ISSUES);
  assert.equal(dropped, 0);
});

test("no failures → empty selection, nothing dropped", () => {
  const run = mkRun([specWith([mkTest({ status: "passed" }), mkTest({ status: "skipped" })])]);
  const { selected, dropped } = selectFailuresForAutoCreate(run);
  assert.equal(selected.length, 0);
  assert.equal(dropped, 0);
});

test("a custom cap is honoured (drop math is relative to it)", () => {
  const failures = Array.from({ length: 5 }, (_, i) => mkTest({ full_title: `f${i}` }));
  const { selected, dropped } = selectFailuresForAutoCreate(mkRun([specWith(failures)]), 3);
  assert.equal(selected.length, 3);
  assert.equal(dropped, 2);
});
