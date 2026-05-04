import type pg from "pg";
import type { NormalizedRun } from "./types.js";

/**
 * Find an existing run to merge into, or create a new one.
 *
 * Merge condition: same ci_run_id + suite_name + org_id, and ci_run_id is non-empty.
 * Returns the run ID (existing or newly created).
 */
export async function findOrCreateRun(
  client: pg.PoolClient,
  orgId: number,
  run: NormalizedRun
): Promise<{ runId: number; merged: boolean }> {
  const { meta, stats } = run;

  const environment = (meta.environment ?? "").trim();

  // For ci_run_id-tagged uploads we use INSERT ... ON CONFLICT against
  // the partial unique index uniq_runs_ci_run (migration 035).  This
  // is the only race-safe way to merge concurrent CI workers onto the
  // same run row — the previous `SELECT then INSERT` pattern allowed
  // two simultaneous calls to each see "no existing row" and each
  // INSERT, producing distinct runs and breaking the merge guarantee.
  //
  // The xmax = 0 trick distinguishes inserted from updated:
  //   xmax = 0 → row was just inserted (we're the first writer)
  //   xmax ≠ 0 → row already existed (we hit ON CONFLICT, returned existing id)
  if (meta.ci_run_id) {
    const upserted = await client.query(
      `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id, environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (org_id, suite_name, ci_run_id) WHERE ci_run_id <> ''
       DO UPDATE SET
         -- No-op set so RETURNING fires on conflict.  Don't overwrite
         -- aggregate stats here; recalculateRunStats does that after
         -- specs are merged in.  DO backfill environment if the
         -- existing row has none and the upload carries one.
         environment = CASE
           WHEN runs.environment = '' AND EXCLUDED.environment <> '' THEN EXCLUDED.environment
           ELSE runs.environment
         END
       RETURNING id, (xmax = 0) AS inserted`,
      [
        meta.suite_name, meta.branch, meta.commit_sha, meta.ci_run_id,
        meta.reporter, meta.started_at, meta.finished_at,
        stats.total, stats.passed, stats.failed, stats.skipped, stats.pending, stats.duration_ms,
        orgId, environment,
      ]
    );
    const row = upserted.rows[0];
    return { runId: row.id, merged: !row.inserted };
  }

  // No ci_run_id: just create a new row (no merging possible).
  const result = await client.query(
    `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id, environment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      meta.suite_name, meta.branch, meta.commit_sha, meta.ci_run_id,
      meta.reporter, meta.started_at, meta.finished_at,
      stats.total, stats.passed, stats.failed, stats.skipped, stats.pending, stats.duration_ms,
      orgId, environment,
    ]
  );

  return { runId: result.rows[0].id, merged: false };
}

/**
 * After merging specs into an existing run, recalculate the run's aggregate stats
 * from its specs and tests.
 *
 * `pending` is derived from the tests table (specs only carries a combined
 * skipped+pending count). Initial-create populates runs.pending from the
 * normalized stats, so dropping it to a hardcoded 0 here would silently lose
 * the count whenever a run gets merged.
 */
export async function recalculateRunStats(client: pg.PoolClient, runId: number): Promise<void> {
  await client.query(
    `UPDATE runs SET
      total = sub.total,
      passed = sub.passed,
      failed = sub.failed,
      skipped = sub.skipped,
      pending = sub.pending,
      duration_ms = sub.duration_ms,
      finished_at = GREATEST(runs.finished_at, NOW())
     FROM (
       SELECT
         COALESCE(SUM(s.total), 0)::int AS total,
         COALESCE(SUM(s.passed), 0)::int AS passed,
         COALESCE(SUM(s.failed), 0)::int AS failed,
         COALESCE(SUM(s.skipped), 0)::int AS skipped,
         COALESCE((
           SELECT COUNT(*)::int FROM tests t
           JOIN specs sp ON sp.id = t.spec_id
           WHERE sp.run_id = $1 AND t.status = 'pending'
         ), 0) AS pending,
         COALESCE(SUM(s.duration_ms), 0)::bigint AS duration_ms
       FROM specs s
       WHERE s.run_id = $1
     ) sub
     WHERE runs.id = $1`,
    [runId]
  );
}
