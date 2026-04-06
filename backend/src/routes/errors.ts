import { Router } from "express";
import pool from "../db.js";

const router = Router();

// GET /errors — aggregated error groups
// Query params: ?suite=name&run_id=123
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const runId = req.query.run_id as string | undefined;

    const conditions: string[] = ["t.status = 'failed'", "t.error_message IS NOT NULL"];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (suite) {
      conditions.push(`r.suite_name = $${paramIndex++}`);
      params.push(suite);
    }

    if (runId) {
      conditions.push(`r.id = $${paramIndex++}`);
      params.push(Number(runId));
    }

    const where = conditions.join(" AND ");

    const result = await pool.query(
      `SELECT
        t.error_message,
        t.title AS test_title,
        s.file_path,
        r.suite_name,
        COUNT(*)::int AS count,
        MAX(r.id) AS latest_run_id,
        MAX(r.created_at) AS latest_run_date,
        ARRAY_AGG(DISTINCT r.id ORDER BY r.id DESC) AS run_ids
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE ${where}
      GROUP BY t.error_message, t.title, s.file_path, r.suite_name
      ORDER BY count DESC, latest_run_date DESC
      LIMIT 100`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /errors error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
