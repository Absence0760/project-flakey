// Canonical ship-gate status for a run.
//
// The badge (routes/badge.ts) and the JSON ship-signal endpoint
// (GET /runs/status) both derive from this single function, so the two
// machine-readable signals a CI job might poll can never disagree — the
// drift between "what the badge shows" and "what the API says" is exactly
// the trust gap the release-manager review flagged.

export type ShipStatus = "passed" | "failed" | "incomplete" | "aborted";

export interface RunStatusInput {
  // runs.failed aggregate. Authoritative once the run has finished_at set
  // (recalculateRunStats writes it on the final shard merge).
  failed: number;
  // True when a `run.aborted` live_events row exists for the run (a CI kill /
  // OOM / network drop). Callers compute this via an EXISTS subquery.
  aborted: boolean;
  // NULL until the run merges/completes (migration 050). NULL means the run is
  // live or only partially merged — not yet finished.
  finished_at: Date | string | null;
  // Aggregate counts. Used to detect a finished run that still has tests with
  // no terminal result (pending): total > passed + skipped (with failed = 0).
  total: number;
  passed: number;
  skipped: number;
}

/**
 * Classify a run into a single ship-gate status. Precedence, highest first:
 *
 *  - `failed`     — any recorded failure. Checked first so the actionable
 *                   failure count survives (the badge shows "N failed").
 *  - `aborted`    — the run was killed mid-flight with no recorded failure.
 *  - `incomplete` — a live / partially-merged run that has not finished, OR a
 *                   finished run that still has pending tests (no terminal
 *                   result for every test). Either way the pass/fail picture
 *                   is not complete, so it is not a clean pass.
 *  - `passed`     — finished, not aborted, zero failures, every test accounted
 *                   for (passed + skipped === total).
 *
 * Any status other than `passed` means do-not-ship. Callers that read this as
 * a gate therefore fail closed by treating "not passed" as a hold.
 *
 * The badge (routes/badge.ts) maps this 1:1 — it renders green **exactly when**
 * this returns `passed` — so the badge and GET /runs/status can never give a
 * CI job contradictory ship answers.
 */
export function classifyRunStatus(run: RunStatusInput): ShipStatus {
  if (run.failed > 0) return "failed";
  if (run.aborted) return "aborted";
  if (run.finished_at === null) return "incomplete";
  // Finished, not aborted, no failures — but if some tests never produced a
  // terminal result (pending: total exceeds passed + skipped), the result set
  // is incomplete, not a clean pass. Treating it as "passed" would be exactly
  // the false-green this classifier exists to prevent.
  if (run.passed + run.skipped < run.total) return "incomplete";
  return "passed";
}
