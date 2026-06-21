// Pure helpers for the /errors triage surface (Phase 15.1). Kept free of Svelte
// and the API client so the list/filter logic is unit-testable in isolation.
import type { ErrorGroup } from "$lib/api";

// The triage-specific list filters layered on top of the server-side
// suite/status filters. "all" = no triage filter applied.
export type TriageFilter = "all" | "mine" | "overdue";

/**
 * Is this error group overdue? True when it has a target_date strictly before
 * `today` (a YYYY-MM-DD string). The comparison is lexical on the date string,
 * which is correct for the ISO YYYY-MM-DD form and sidesteps timezone drift
 * from constructing Date objects. A group with no target_date is never overdue.
 */
export function isOverdue(group: Pick<ErrorGroup, "target_date">, today: string): boolean {
  if (!group.target_date) return false;
  return group.target_date < today;
}

/**
 * Apply a triage list filter to a set of error groups.
 *
 * - "all": pass everything through (the triage filter is off).
 * - "mine": only groups assigned to `currentUserId`. When the viewer has no
 *   user id, nothing is "mine" — return empty rather than silently showing all.
 * - "overdue": only groups whose target_date is before `today`.
 *
 * Pure: returns a new array, never mutates the input. The caller already
 * narrowed by suite/status/search; this composes on top of that.
 */
export function applyTriageFilter(
  groups: ErrorGroup[],
  filter: TriageFilter,
  opts: { currentUserId: number | null; today: string }
): ErrorGroup[] {
  switch (filter) {
    case "mine":
      if (opts.currentUserId === null) return [];
      return groups.filter((g) => g.assigned_to === opts.currentUserId);
    case "overdue":
      return groups.filter((g) => isOverdue(g, opts.today));
    case "all":
    default:
      return groups;
  }
}

/** Today's date as a YYYY-MM-DD string in the local timezone — the `today`
 * argument the filters compare against. Local (not UTC) so "overdue" matches
 * the user's wall-clock day. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Priority display metadata — label + status-tint colour for the chip. Mirrors
// the `statuses` table on the errors page so the two read consistently.
export const PRIORITY_META: Record<
  NonNullable<ErrorGroup["priority"]>,
  { label: string; color: string }
> = {
  critical: { label: "Critical", color: "var(--color-fail)" },
  high: { label: "High", color: "#e8830c" },
  medium: { label: "Medium", color: "#dfb317" },
  low: { label: "Low", color: "var(--text-muted)" },
};
