import { Router } from "express";
import pool from "../db.js";

const router = Router();

// GET /stats — dashboard overview
router.get("/", async (_req, res) => {
  try {
    const runsResult = await pool.query(`
      SELECT
        COUNT(*)::int AS total_runs,
        COALESCE(SUM(total), 0)::int AS total_tests,
        COALESCE(SUM(passed), 0)::int AS total_passed,
        COALESCE(SUM(failed), 0)::int AS total_failed
      FROM runs
    `);

    const stats = runsResult.rows[0];
    const passRate = stats.total_tests > 0
      ? Math.round((stats.total_passed / stats.total_tests) * 100)
      : 0;

    const recentRuns = await pool.query(
      "SELECT * FROM runs ORDER BY created_at DESC LIMIT 5"
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
      ORDER BY r.created_at DESC, t.id DESC
      LIMIT 10
    `);

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
