import { describe, it, expect } from "vitest";
import { applyTriageFilter, isOverdue, todayISO, PRIORITY_META, type TriageFilter } from "./error-triage.js";
import type { ErrorGroup } from "$lib/api";

// Minimal ErrorGroup factory — only the fields the triage filters read matter;
// the rest are filled with inert defaults so the type is satisfied.
function group(over: Partial<ErrorGroup>): ErrorGroup {
  return {
    fingerprint: over.fingerprint ?? "fp",
    error_message: "boom",
    occurrence_count: 1,
    affected_tests: 1,
    affected_runs: 1,
    first_seen: "2026-01-01",
    last_seen: "2026-01-01",
    latest_run_id: 1,
    latest_test_id: 1,
    test_titles: [],
    file_paths: [],
    suite_name: "s",
    group_id: null,
    status: "open",
    assigned_to: null,
    assigned_to_email: null,
    target_date: null,
    priority: null,
    priority_source: "derived",
    recurrence_count: 0,
    last_recurred_at: null,
    note_count: 0,
    quarantine_suggested: false,
    ...over,
  };
}

describe("isOverdue", () => {
  it("is false when there is no target_date", () => {
    expect(isOverdue({ target_date: null }, "2026-06-21")).toBe(false);
  });

  it("is true when target_date is strictly before today", () => {
    expect(isOverdue({ target_date: "2026-06-20" }, "2026-06-21")).toBe(true);
  });

  it("is false when target_date is today (due, not yet overdue)", () => {
    expect(isOverdue({ target_date: "2026-06-21" }, "2026-06-21")).toBe(false);
  });

  it("is false when target_date is in the future", () => {
    expect(isOverdue({ target_date: "2026-07-01" }, "2026-06-21")).toBe(false);
  });
});

describe("applyTriageFilter", () => {
  const mineA = group({ fingerprint: "a", assigned_to: 7 });
  const someoneElse = group({ fingerprint: "b", assigned_to: 9 });
  const unassigned = group({ fingerprint: "c", assigned_to: null });
  const overdue = group({ fingerprint: "d", target_date: "2026-06-01" });
  const future = group({ fingerprint: "e", target_date: "2026-12-01" });
  const groups = [mineA, someoneElse, unassigned, overdue, future];
  const opts = { currentUserId: 7, today: "2026-06-21" };

  it("returns everything for 'all'", () => {
    expect(applyTriageFilter(groups, "all", opts)).toEqual(groups);
  });

  it("'mine' keeps only groups assigned to the current user", () => {
    expect(applyTriageFilter(groups, "mine", opts).map((g) => g.fingerprint)).toEqual(["a"]);
  });

  it("'mine' returns nothing when the viewer has no user id", () => {
    expect(applyTriageFilter(groups, "mine", { currentUserId: null, today: "2026-06-21" })).toEqual([]);
  });

  it("'overdue' keeps only groups past their target_date", () => {
    expect(applyTriageFilter(groups, "overdue", opts).map((g) => g.fingerprint)).toEqual(["d"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...groups];
    applyTriageFilter(groups, "mine", opts);
    expect(groups).toEqual(copy);
  });

  it("falls back to 'all' for an unknown filter value", () => {
    expect(applyTriageFilter(groups, "bogus" as TriageFilter, opts)).toEqual(groups);
  });

  it("'mine' never matches an unassigned group (assigned_to null !== a real user id)", () => {
    // Defence against a falsy-comparison regression: null must not equal 0 or
    // be coerced into "mine".
    const onlyUnassigned = [unassigned];
    expect(applyTriageFilter(onlyUnassigned, "mine", opts)).toEqual([]);
    // …and with currentUserId 0 (a falsy-but-real id), a null assignee still
    // doesn't match, while a group genuinely assigned to user 0 does.
    const userZero = group({ fingerprint: "z", assigned_to: 0 });
    expect(
      applyTriageFilter([unassigned, userZero], "mine", { currentUserId: 0, today: "2026-06-21" }).map(
        (g) => g.fingerprint
      )
    ).toEqual(["z"]);
  });

  it("'overdue' returns an empty array when nothing is past due", () => {
    expect(applyTriageFilter([future, unassigned], "overdue", opts)).toEqual([]);
  });

  it("returns an empty array unchanged for every filter mode", () => {
    for (const f of ["all", "mine", "overdue"] as const) {
      expect(applyTriageFilter([], f, opts)).toEqual([]);
    }
  });
});

describe("todayISO", () => {
  it("formats a Date as zero-padded YYYY-MM-DD", () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(todayISO(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("PRIORITY_META", () => {
  it("has an entry for every priority value", () => {
    expect(Object.keys(PRIORITY_META).sort()).toEqual(["critical", "high", "low", "medium"]);
  });
});
