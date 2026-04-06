import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /tests/:id — single test with spec info and prev/next navigation
router.get("/:id", async (req, res) => {
  try {
    const testId = req.params.id;

    const orgId = req.user!.orgId;

    const testResult = await tenantQuery(orgId,
      `SELECT t.*, s.file_path, s.run_id, s.title AS spec_title
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       WHERE t.id = $1`,
      [testId]
    );

    if (testResult.rows.length === 0) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const test = testResult.rows[0];

    // Get prev/next failed tests within the same run
    const failedInRun = await tenantQuery(orgId,
      `SELECT t.id FROM tests t
       JOIN specs s ON s.id = t.spec_id
       WHERE s.run_id = $1 AND t.status = 'failed'
       ORDER BY t.id`,
      [test.run_id]
    );

    const failedIds = failedInRun.rows.map((r: { id: number }) => r.id);
    const currentIndex = failedIds.indexOf(test.id);

    res.json({
      ...test,
      prev_failed_id: currentIndex > 0 ? failedIds[currentIndex - 1] : null,
      next_failed_id: currentIndex < failedIds.length - 1 ? failedIds[currentIndex + 1] : null,
      failed_index: currentIndex + 1,
      failed_total: failedIds.length,
    });
  } catch (err) {
    console.error("GET /tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /tests/:id/history — pass/fail timeline for this test across runs
router.get("/:id/history", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const testId = req.params.id;

    // Get the test's title and file_path to find matching tests
    const testResult = await tenantQuery(orgId,
      `SELECT t.title, s.file_path
       FROM tests t JOIN specs s ON s.id = t.spec_id
       WHERE t.id = $1`,
      [testId]
    );

    if (testResult.rows.length === 0) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const { title, file_path } = testResult.rows[0];

    // Find all instances of this test across runs
    const history = await tenantQuery(orgId, `
      SELECT
        t.id AS test_id,
        t.status,
        t.duration_ms,
        t.error_message,
        r.id AS run_id,
        r.suite_name,
        r.branch,
        r.created_at
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.title = $1 AND s.file_path = $2
      ORDER BY r.created_at DESC
      LIMIT 50
    `, [title, file_path]);

    res.json({
      title,
      file_path,
      history: history.rows,
    });
  } catch (err) {
    console.error("GET /tests/:id/history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
