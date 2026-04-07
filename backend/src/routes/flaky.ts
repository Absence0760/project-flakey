import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /flaky — server-side flaky test detection
// Query params: ?suite=name&limit=50&runs=30
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const runLimit = Math.min(Number(req.query.runs) || 30, 100);
    const resultLimit = Math.min(Number(req.query.limit) || 50, 200);
    const orgId = req.user!.orgId;

    // Build the run filter
    let runFilter = "";
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (suite) {
      runFilter = `AND r.suite_name = $${paramIndex++}`;
      params.push(suite);
    }

    // Get flaky tests: tests that have both passed and failed across recent runs,
    // with their full status timeline
    const result = await tenantQuery(orgId,
      `WITH recent_runs AS (
        SELECT id, suite_name, created_at
        FROM runs
        WHERE TRUE ${runFilter}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++}
      ),
      test_results AS (
        SELECT
          t.full_title,
          t.title,
          s.file_path,
          r.suite_name,
          t.status,
          r.created_at AS run_date,
          r.id AS run_id,
          ROW_NUMBER() OVER (PARTITION BY t.full_title, r.suite_name ORDER BY r.created_at DESC) AS rn
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
          ARRAY_AGG(status ORDER BY run_date ASC) AS timeline,
          ARRAY_AGG(run_id ORDER BY run_date ASC) AS run_ids,
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
      LIMIT $${paramIndex++}`,
      [...params, runLimit, resultLimit]
    );

    // Compute flip count from timeline
    const rows = result.rows.map((row) => {
      const timeline: string[] = row.timeline;
      let flipCount = 0;
      for (let i = 1; i < timeline.length; i++) {
        if (timeline[i] !== timeline[i - 1]) flipCount++;
      }
      return {
        ...row,
        flip_count: flipCount,
        total_runs: row.total_runs,
        pass_count: row.pass_count,
        fail_count: row.fail_count,
        flaky_rate: Number(row.flaky_rate),
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("GET /flaky error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
