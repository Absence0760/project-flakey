import { tenantQuery } from "./db.js";

// Shared N-run windowed flaky-test detection. A flaky test is one that both
// passed and failed across the recent run window for an org (optionally
// filtered to a single suite). This is the single source of truth for the
// windowed computation used by GET /flaky and the flaky.detected webhook —
// keep it in lockstep with both call sites' expectations. (The 2-run
// this-run-vs-previous diff in git-providers/index.ts is a *different*
// computation and intentionally does not go through here.)

export interface FlakyTest {
  full_title: string;
  title: string;
  file_path: string;
  suite_name: string;
  total_runs: number;
  pass_count: number;
  fail_count: number;
  first_seen: Date;
  last_seen: Date;
  timeline: string[];
  run_ids: number[];
  latest_run_id: number;
  flaky_rate: number;
  flip_count: number;
}

/**
 * Count adjacent status changes ("flips") across a timeline of statuses.
 * A pure helper so it can be unit-tested and reused internally.
 */
export function countFlips(timeline: string[]): number {
  let flipCount = 0;
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i] !== timeline[i - 1]) flipCount++;
  }
  return flipCount;
}

/**
 * Compute windowed flaky tests for an org.
 *
 * @param orgId tenant id (RLS-scoped via tenantQuery — never bare pool)
 * @param opts.suite     restrict the run window to a single suite_name
 * @param opts.runWindow how many recent runs feed the classification
 *                       (default 30, clamped to a max of 500)
 * @param opts.limit     cap the number of flaky tests returned; omit for no cap
 * @param opts.orderBy   column the timeline (and thus flip_count) is ordered by.
 *                       'run_date' (default) matches GET /flaky; the flaky.detected
 *                       webhook passes 'run_id' to preserve its original ordering —
 *                       run_id (serial) and created_at can diverge under concurrent
 *                       / live uploads, which would otherwise shift flip_count and
 *                       change whether the event fires.
 */
export async function computeFlakyTests(
  orgId: number,
  opts: { suite?: string; runWindow?: number; limit?: number; orderBy?: "run_date" | "run_id" }
): Promise<FlakyTest[]> {
  const runLimit = Math.min(opts.runWindow ?? 30, 500);
  const timelineOrder = opts.orderBy === "run_id" ? "run_id" : "run_date";

  // Build the run filter. The recent_runs CTE references the table without an
  // alias, so `suite_name` is the correct unqualified column name.
  let runFilter = "";
  const params: (string | number)[] = [];
  let paramIndex = 1;

  if (opts.suite) {
    runFilter = `AND suite_name = $${paramIndex++}`;
    params.push(opts.suite);
  }

  // The run-window param always comes next.
  const runLimitPlaceholder = `$${paramIndex++}`;
  params.push(runLimit);

  // Optional result LIMIT — only appended when a limit is requested.
  let limitClause = "";
  if (opts.limit !== undefined) {
    limitClause = `LIMIT $${paramIndex++}`;
    params.push(opts.limit);
  }

  // Get flaky tests: tests that have both passed and failed across recent runs,
  // with their full status timeline
  const result = await tenantQuery(orgId,
    `WITH recent_runs AS (
      SELECT id, suite_name, created_at
      FROM runs
      WHERE TRUE ${runFilter}
      ORDER BY created_at DESC
      LIMIT ${runLimitPlaceholder}
    ),
    test_results AS (
      SELECT
        t.full_title,
        t.title,
        s.file_path,
        r.suite_name,
        t.status,
        r.created_at AS run_date,
        r.id AS run_id
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN recent_runs r ON r.id = s.run_id
      WHERE t.status IN ('passed', 'failed')
    ),
    flaky_candidates AS (
      SELECT
        full_title,
        title,
        file_path,
        suite_name,
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'passed')::int AS pass_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS fail_count,
        MIN(run_date) AS first_seen,
        MAX(run_date) AS last_seen,
        ARRAY_AGG(status ORDER BY ${timelineOrder} ASC) AS timeline,
        ARRAY_AGG(run_id ORDER BY ${timelineOrder} ASC) AS run_ids,
        MAX(run_id) AS latest_run_id
      FROM test_results
      GROUP BY full_title, title, file_path, suite_name
      HAVING COUNT(*) FILTER (WHERE status = 'passed') > 0
         AND COUNT(*) FILTER (WHERE status = 'failed') > 0
    )
    SELECT *,
      ROUND(fail_count::numeric / total_runs * 100, 1) AS flaky_rate
    FROM flaky_candidates
    ORDER BY flaky_rate DESC, fail_count DESC
    ${limitClause}`,
    params
  );

  // Compute flip count from timeline; coerce flaky_rate to a number
  // (total/pass/fail are already ::int from SQL).
  return result.rows.map((row) => {
    const timeline: string[] = row.timeline;
    return {
      ...row,
      flip_count: countFlips(timeline),
      total_runs: row.total_runs,
      pass_count: row.pass_count,
      fail_count: row.fail_count,
      flaky_rate: Number(row.flaky_rate),
    } as FlakyTest;
  });
}
