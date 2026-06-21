// Phase 15.2 — pure, unit-testable helpers for data-native error-group
// automation. No DB, no I/O: the autoclose window predicate and the read-time
// derived-priority function both live here so the seams the project's
// "no untestable" rule wants are isolated and deterministic.

export type ErrorPriority = "low" | "medium" | "high" | "critical";

/**
 * The signals a derived priority is computed from. All come from data the
 * /errors aggregate already holds — no extra query for the derivation itself.
 *
 *  - occurrenceCount: total failing occurrences of this fingerprint.
 *  - affectedRuns:    distinct runs the fingerprint has appeared in (breadth).
 *  - flakyRate:       0–100 flaky percentage for the worst matching test, or
 *                     null when the fingerprint isn't a known flaky test.
 */
export interface DerivedPrioritySignals {
  occurrenceCount: number;
  affectedRuns: number;
  flakyRate: number | null;
}

/**
 * Derive a default priority for an error group whose `priority` is unset.
 *
 * Read-time only — NEVER stored, so it can't drift from the underlying data,
 * and NEVER overwrites a human-set value (the caller only invokes this when
 * priority IS NULL). Deterministic and monotonic in each signal:
 *
 *  - Breadth across runs is the strongest signal that a failure is real and
 *    not a one-off: a fingerprint hitting many runs is escalated hardest.
 *  - Raw occurrence volume escalates more gently (a single flapping run can
 *    rack up occurrences without breadth).
 *  - A high flaky rate *caps* the result: a test that's flaky (passes and
 *    fails) is noise, not a hard regression — we down-rank it so the chip
 *    doesn't scream "critical" at a known-flaky test. A non-flaky fingerprint
 *    (flakyRate null or low) keeps its breadth-driven score.
 *
 * The thresholds are intentionally coarse — this is a *default* a human can
 * override, not a precise SLA. Bands:
 *   critical: ≥10 affected runs (broad, sustained) and not heavily flaky
 *   high:     ≥5 affected runs, or ≥20 occurrences
 *   medium:   ≥2 affected runs, or ≥5 occurrences
 *   low:      everything else (a single-run blip)
 * A flakyRate ≥ 50 clamps the ceiling to `medium` (it's flake, not regression).
 */
export function deriveErrorPriority(signals: DerivedPrioritySignals): ErrorPriority {
  const runs = Number.isFinite(signals.affectedRuns) ? Math.max(0, signals.affectedRuns) : 0;
  const occ = Number.isFinite(signals.occurrenceCount) ? Math.max(0, signals.occurrenceCount) : 0;
  const flaky = signals.flakyRate == null || !Number.isFinite(signals.flakyRate)
    ? 0
    : Math.max(0, Math.min(100, signals.flakyRate));

  let band: ErrorPriority;
  if (runs >= 10) band = "critical";
  else if (runs >= 5 || occ >= 20) band = "high";
  else if (runs >= 2 || occ >= 5) band = "medium";
  else band = "low";

  // A heavily-flaky fingerprint is noise, not a hard regression: clamp the
  // ceiling so a flapping test never derives above `medium`.
  if (flaky >= 50) {
    const order: ErrorPriority[] = ["low", "medium", "high", "critical"];
    if (order.indexOf(band) > order.indexOf("medium")) band = "medium";
  }

  return band;
}

// The error-group statuses the nightly auto-close-on-green sweep is allowed to
// transition. `known`/`ignored` are deliberate human states (don't touch), and
// `fixed` is already terminal. `regressed` IS eligible — a regression that then
// goes quiet for the window is itself a candidate to re-close.
export const AUTOCLOSE_ELIGIBLE_STATUSES = ["open", "investigating", "regressed"] as const;
export type AutocloseEligibleStatus = (typeof AUTOCLOSE_ELIGIBLE_STATUSES)[number];

export function isAutocloseEligibleStatus(status: string): status is AutocloseEligibleStatus {
  return (AUTOCLOSE_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Pure predicate: should an error group auto-close on the nightly green sweep?
 *
 * "Green" = the fingerprint has not reappeared (its most-recent run) for at
 * least `autocloseDays` days. Closed only when ALL hold:
 *
 *  - autocloseDays is a positive number (NULL/0/negative = OFF → never close).
 *  - the group's status is one the sweep may touch (see ELIGIBLE above).
 *  - lastSeen is non-null and strictly older than (now − autocloseDays days).
 *
 * Time math is done on epoch-millis so it's timezone-agnostic and trivially
 * testable: the caller passes `now`, the group's `lastSeen`, and the window.
 * A null lastSeen (a group with no observed failures) is never auto-closed —
 * we only close on positive evidence of green, never on absence of data.
 */
export function isAutocloseEligible(args: {
  status: string;
  lastSeen: Date | string | null | undefined;
  autocloseDays: number | null | undefined;
  now: Date;
}): boolean {
  const days = args.autocloseDays;
  if (days == null || !Number.isFinite(days) || days <= 0) return false;
  if (!isAutocloseEligibleStatus(args.status)) return false;
  if (args.lastSeen == null) return false;

  const lastSeenMs = args.lastSeen instanceof Date
    ? args.lastSeen.getTime()
    : Date.parse(String(args.lastSeen));
  if (!Number.isFinite(lastSeenMs)) return false;

  const cutoffMs = args.now.getTime() - days * 24 * 60 * 60 * 1000;
  return lastSeenMs < cutoffMs;
}
