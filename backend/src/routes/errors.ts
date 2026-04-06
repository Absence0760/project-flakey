import { Router } from "express";
import pool from "../db.js";

const router = Router();

// GET /errors — aggregated error groups
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.error_message,
        t.title AS test_title,
        s.file_path,
        COUNT(*)::int AS count,
        MAX(r.id) AS latest_run_id,
        MAX(r.created_at) AS latest_run_date,
        ARRAY_AGG(DISTINCT r.id ORDER BY r.id DESC) AS run_ids
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'failed' AND t.error_message IS NOT NULL
      GROUP BY t.error_message, t.title, s.file_path
      ORDER BY count DESC, latest_run_date DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /errors error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
