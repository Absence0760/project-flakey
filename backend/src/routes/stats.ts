import { Router } from "express";
import pool from "../db.js";

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

    const runsResult = await pool.query(`
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

    const recentRuns = await pool.query(
      `SELECT * FROM runs ${dateFilter} ORDER BY created_at DESC LIMIT 5`,
      params
    );

    const recentFailures = await pool.query(`
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

    res.json({
      ...stats,
      pass_rate: passRate,
      recent_runs: recentRuns.rows,
      recent_failures: recentFailures.rows,
    });
  } catch (err) {
    console.error("GET /stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
