import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /stats — dashboard overview
router.get("/", async (req, res) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    let dateFilter = "";
    let dateFilterJoin = "";
    const params: string[] = [];

    if (from && to) {
      params.push(from, to);
      dateFilter = `WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')`;
      dateFilterJoin = `AND r.created_at >= $1::date AND r.created_at < ($2::date + INTERVAL '1 day')`;
    } else if (from) {
      params.push(from);
      dateFilter = `WHERE created_at >= $1::date`;
      dateFilterJoin = `AND r.created_at >= $1::date`;
    } else if (to) {
      params.push(to);
      dateFilter = `WHERE created_at < ($1::date + INTERVAL '1 day')`;
      dateFilterJoin = `AND r.created_at < ($1::date + INTERVAL '1 day')`;
    }

    const orgId = req.user!.orgId;

    const runsResult = await tenantQuery(orgId, `
      SELECT
        COUNT(*)::int AS total_runs,
        COALESCE(SUM(total), 0)::int AS total_tests,
        COALESCE(SUM(passed), 0)::int AS total_passed,
        COALESCE(SUM(failed), 0)::int AS total_failed
      FROM runs
      ${dateFilter}
    `, params);

    const stats = runsResult.rows[0];
    const passRate = stats.total_tests > 0
      ? Math.round((stats.total_passed / stats.total_tests) * 100)
      : 0;

    const recentRuns = await tenantQuery(orgId,
      `SELECT * FROM runs ${dateFilter} ORDER BY created_at DESC LIMIT 20`,
      params
    );

    const recentFailures = await tenantQuery(orgId, `
      SELECT
        t.title AS test_title,
        t.error_message,
        r.id AS run_id,
        s.file_path
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'failed' AND t.error_message IS NOT NULL
      ${dateFilterJoin}
      ORDER BY r.created_at DESC, t.id DESC
      LIMIT 10
    `, params);

    // Manual tests: two separate things reported under `manual`.
    // 1. Catalog state (total/passed/failed/blocked/skipped/not_run) —
    //    current status of every manual test case. Not dated.
    // 2. Execution activity (total_runs/passed_runs/failed_runs) —
    //    counted from manual_test_runs within the selected date range.
    //    Each ad-hoc execution appends a row there, so repeat runs count.
    // `recent_results` and `recent_failures` are date-scoped via last_run_at.
    let manualActivityFilter = "last_run_at IS NOT NULL";
    let manualRunsFilter = "";
    const manualParams: string[] = [];
    if (from && to) {
      manualParams.push(from, to);
      manualActivityFilter = `last_run_at >= $1::date AND last_run_at < ($2::date + INTERVAL '1 day')`;
      manualRunsFilter = `WHERE run_at >= $1::date AND run_at < ($2::date + INTERVAL '1 day')`;
    } else if (from) {
      manualParams.push(from);
      manualActivityFilter = `last_run_at >= $1::date`;
      manualRunsFilter = `WHERE run_at >= $1::date`;
    } else if (to) {
      manualParams.push(to);
      manualActivityFilter = `last_run_at < ($1::date + INTERVAL '1 day')`;
      manualRunsFilter = `WHERE run_at < ($1::date + INTERVAL '1 day')`;
    }

    const manualSummary = await tenantQuery(orgId, `
      SELECT
        COUNT(*)::int                                            AS total,
        COUNT(*) FILTER (WHERE status = 'passed')::int           AS passed,
        COUNT(*) FILTER (WHERE status = 'failed')::int           AS failed,
        COUNT(*) FILTER (WHERE status = 'blocked')::int          AS blocked,
        COUNT(*) FILTER (WHERE status = 'skipped')::int          AS skipped,
        COUNT(*) FILTER (WHERE status = 'not_run')::int          AS not_run
      FROM manual_tests
    `);
    const m = manualSummary.rows[0];
    const manualExecuted = m.passed + m.failed + m.blocked + m.skipped;

    const manualRunCounts = await tenantQuery(orgId, `
      SELECT
        COUNT(*)::int                                   AS total_runs,
        COUNT(*) FILTER (WHERE status = 'passed')::int  AS passed_runs,
        COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed_runs
      FROM manual_test_runs
      ${manualRunsFilter}
    `, manualParams);
    const mr = manualRunCounts.rows[0];
    const manualPassRate = mr.total_runs > 0
      ? Math.round((mr.passed_runs / mr.total_runs) * 100)
      : 0;

    const manualRecentResults = await tenantQuery(orgId, `
      SELECT mt.id, mt.title, mt.suite_name, mt.status, mt.last_run_at,
             u.email AS last_run_by_email
        FROM manual_tests mt
        LEFT JOIN users u ON u.id = mt.last_run_by
       WHERE ${manualActivityFilter}
       ORDER BY mt.last_run_at DESC
       LIMIT 10
    `, manualParams);

    const manualRecentFailures = await tenantQuery(orgId, `
      SELECT id, title, suite_name, last_run_at, last_run_notes
        FROM manual_tests
       WHERE status = 'failed' AND ${manualActivityFilter}
       ORDER BY last_run_at DESC
       LIMIT 10
    `, manualParams);

    res.json({
      automated: {
        total_runs: stats.total_runs,
        total_tests: stats.total_tests,
        total_passed: stats.total_passed,
        total_failed: stats.total_failed,
        pass_rate: passRate,
        recent_runs: recentRuns.rows,
        recent_failures: recentFailures.rows,
      },
      manual: {
        total: m.total,
        passed: m.passed,
        failed: m.failed,
        blocked: m.blocked,
        skipped: m.skipped,
        not_run: m.not_run,
        executed: manualExecuted,
        total_runs: mr.total_runs,
        passed_runs: mr.passed_runs,
        failed_runs: mr.failed_runs,
        pass_rate: manualPassRate,
        recent_results: manualRecentResults.rows,
        recent_failures: manualRecentFailures.rows,
      },
    });
  } catch (err) {
    console.error("GET /stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/trends — time-series data for charts
router.get("/trends", async (req, res) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    let dateFilter = "";
    let dateFilterWhere = "";
    const params: string[] = [];

    if (from && to) {
      params.push(from, to);
      dateFilter = `WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')`;
      dateFilterWhere = `AND r.created_at >= $1::date AND r.created_at < ($2::date + INTERVAL '1 day')`;
    } else if (from) {
      params.push(from);
      dateFilter = `WHERE created_at >= $1::date`;
      dateFilterWhere = `AND r.created_at >= $1::date`;
    } else if (to) {
      params.push(to);
      dateFilter = `WHERE created_at < ($1::date + INTERVAL '1 day')`;
      dateFilterWhere = `AND r.created_at < ($1::date + INTERVAL '1 day')`;
    }

    const orgId = req.user!.orgId;

    // Pass rate over time (per day)
    const passRate = await tenantQuery(orgId, `
      SELECT
        created_at::date AS date,
        COUNT(*)::int AS runs,
        COALESCE(SUM(total), 0)::int AS total,
        COALESCE(SUM(passed), 0)::int AS passed,
        COALESCE(SUM(failed), 0)::int AS failed,
        COALESCE(SUM(skipped), 0)::int AS skipped,
        CASE WHEN SUM(total) > 0
          THEN ROUND((SUM(passed)::numeric / SUM(total)) * 100, 1)
          ELSE 0
        END AS pass_rate
      FROM runs
      ${dateFilter}
      GROUP BY created_at::date
      ORDER BY date
    `, params);

    // Failures by day
    const failuresTrend = await tenantQuery(orgId, `
      SELECT
        r.created_at::date AS date,
        COUNT(*)::int AS failures
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'failed'
      ${dateFilterWhere}
      GROUP BY r.created_at::date
      ORDER BY date
    `, params);

    // Duration trend (avg per day)
    const durationTrend = await tenantQuery(orgId, `
      SELECT
        created_at::date AS date,
        ROUND(AVG(duration_ms))::int AS avg_duration_ms,
        MAX(duration_ms)::int AS max_duration_ms
      FROM runs
      ${dateFilter}
      GROUP BY created_at::date
      ORDER BY date
    `, params);

    // Top failing tests
    const topFailures = await tenantQuery(orgId, `
      SELECT
        t.title AS test_title,
        s.file_path,
        COUNT(*)::int AS failure_count,
        MAX(r.created_at) AS last_failed
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'failed'
      ${dateFilterWhere}
      GROUP BY t.title, s.file_path
      ORDER BY failure_count DESC
      LIMIT 10
    `, params);

    res.json({
      pass_rate: passRate.rows,
      failures: failuresTrend.rows,
      duration: durationTrend.rows,
      top_failures: topFailures.rows,
    });
  } catch (err) {
    console.error("GET /stats/trends error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
