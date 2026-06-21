/**
 * Phase 15.2 pure-helper unit tests — the two deterministic seams the
 * data-native automation hangs on:
 *
 *   - isAutocloseEligible: the nightly auto-close-on-green window predicate.
 *     A wrong answer here either silently closes a still-failing group (the
 *     "trust the numbers" risk the dashboard guards against) or never closes a
 *     genuinely-green one (the feature does nothing).
 *   - deriveErrorPriority: the read-time default priority. A regression here
 *     mis-ranks failures in the triage list — and because it's read-time, every
 *     unset group is affected at once.
 *
 * Both are pure (no DB/I/O), so they're pinned exhaustively here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAutocloseEligible,
  isAutocloseEligibleStatus,
  deriveErrorPriority,
  AUTOCLOSE_ELIGIBLE_STATUSES,
} from "../error-automation.js";

const NOW = new Date("2026-06-21T12:00:00Z");
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

// ── isAutocloseEligible: the OFF switch ──────────────────────────────────────

test("autoclose is OFF when the window is null / 0 / negative / NaN", () => {
  const base = { status: "open", lastSeen: daysAgo(100), now: NOW };
  assert.equal(isAutocloseEligible({ ...base, autocloseDays: null }), false);
  assert.equal(isAutocloseEligible({ ...base, autocloseDays: undefined }), false);
  assert.equal(isAutocloseEligible({ ...base, autocloseDays: 0 }), false);
  assert.equal(isAutocloseEligible({ ...base, autocloseDays: -5 }), false);
  assert.equal(isAutocloseEligible({ ...base, autocloseDays: NaN }), false);
});

// ── isAutocloseEligible: status gating ───────────────────────────────────────

test("only open/investigating/regressed are eligible — human states are not", () => {
  const old = { lastSeen: daysAgo(100), autocloseDays: 7, now: NOW };
  assert.equal(isAutocloseEligible({ ...old, status: "open" }), true);
  assert.equal(isAutocloseEligible({ ...old, status: "investigating" }), true);
  assert.equal(isAutocloseEligible({ ...old, status: "regressed" }), true);
  // Human / terminal states are left alone.
  assert.equal(isAutocloseEligible({ ...old, status: "known" }), false);
  assert.equal(isAutocloseEligible({ ...old, status: "ignored" }), false);
  assert.equal(isAutocloseEligible({ ...old, status: "fixed" }), false);
  assert.equal(isAutocloseEligible({ ...old, status: "bogus" }), false);
});

test("AUTOCLOSE_ELIGIBLE_STATUSES + the guard agree", () => {
  assert.deepEqual([...AUTOCLOSE_ELIGIBLE_STATUSES], ["open", "investigating", "regressed"]);
  assert.equal(isAutocloseEligibleStatus("open"), true);
  assert.equal(isAutocloseEligibleStatus("fixed"), false);
});

// ── isAutocloseEligible: the window boundary ─────────────────────────────────

test("closes only when last_seen is STRICTLY older than the window", () => {
  const base = { status: "open", autocloseDays: 7, now: NOW };
  // 10 days quiet, 7-day window → close.
  assert.equal(isAutocloseEligible({ ...base, lastSeen: daysAgo(10) }), true);
  // 3 days quiet → still recent → keep.
  assert.equal(isAutocloseEligible({ ...base, lastSeen: daysAgo(3) }), false);
  // Exactly at the cutoff is NOT strictly older → keep (boundary is inclusive
  // of "still within window").
  assert.equal(isAutocloseEligible({ ...base, lastSeen: daysAgo(7) }), false);
  // A hair past the cutoff → close.
  assert.equal(
    isAutocloseEligible({ ...base, lastSeen: new Date(daysAgo(7).getTime() - 1000) }),
    true
  );
});

test("a null/absent or unparseable last_seen never auto-closes (no green evidence)", () => {
  const base = { status: "open", autocloseDays: 7, now: NOW };
  assert.equal(isAutocloseEligible({ ...base, lastSeen: null }), false);
  assert.equal(isAutocloseEligible({ ...base, lastSeen: undefined }), false);
  assert.equal(isAutocloseEligible({ ...base, lastSeen: "not-a-date" }), false);
});

test("accepts an ISO-string last_seen as well as a Date", () => {
  const base = { status: "open", autocloseDays: 7, now: NOW };
  assert.equal(isAutocloseEligible({ ...base, lastSeen: daysAgo(10).toISOString() }), true);
  assert.equal(isAutocloseEligible({ ...base, lastSeen: daysAgo(2).toISOString() }), false);
});

// ── deriveErrorPriority: monotonic banding ───────────────────────────────────

test("derived priority escalates with breadth across runs", () => {
  assert.equal(deriveErrorPriority({ occurrenceCount: 1, affectedRuns: 1, flakyRate: null }), "low");
  assert.equal(deriveErrorPriority({ occurrenceCount: 4, affectedRuns: 2, flakyRate: null }), "medium");
  assert.equal(deriveErrorPriority({ occurrenceCount: 8, affectedRuns: 5, flakyRate: null }), "high");
  assert.equal(deriveErrorPriority({ occurrenceCount: 30, affectedRuns: 12, flakyRate: null }), "critical");
});

test("raw occurrence volume escalates more gently than breadth", () => {
  // Many occurrences but a single run (a flapping run) → medium/high, not critical.
  assert.equal(deriveErrorPriority({ occurrenceCount: 6, affectedRuns: 1, flakyRate: null }), "medium");
  assert.equal(deriveErrorPriority({ occurrenceCount: 25, affectedRuns: 1, flakyRate: null }), "high");
});

test("a heavily-flaky fingerprint is clamped to at most medium (flake, not regression)", () => {
  // Would be critical on breadth alone…
  assert.equal(deriveErrorPriority({ occurrenceCount: 30, affectedRuns: 12, flakyRate: null }), "critical");
  // …but a >=50% flaky rate down-ranks it to medium.
  assert.equal(deriveErrorPriority({ occurrenceCount: 30, affectedRuns: 12, flakyRate: 80 }), "medium");
  // A low flaky rate does not clamp.
  assert.equal(deriveErrorPriority({ occurrenceCount: 30, affectedRuns: 12, flakyRate: 10 }), "critical");
  // The clamp never RAISES a low result.
  assert.equal(deriveErrorPriority({ occurrenceCount: 1, affectedRuns: 1, flakyRate: 90 }), "low");
});

test("derived priority is defensive against bad inputs", () => {
  assert.equal(deriveErrorPriority({ occurrenceCount: NaN, affectedRuns: NaN, flakyRate: null }), "low");
  assert.equal(deriveErrorPriority({ occurrenceCount: -5, affectedRuns: -3, flakyRate: -10 }), "low");
  // flakyRate above 100 is clamped to 100 (still clamps the band).
  assert.equal(deriveErrorPriority({ occurrenceCount: 30, affectedRuns: 12, flakyRate: 200 }), "medium");
});
