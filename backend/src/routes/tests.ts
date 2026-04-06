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

export default router;
