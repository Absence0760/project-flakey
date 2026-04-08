import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// GET /quarantine — list quarantined tests
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    let query = `SELECT qt.*, u.name AS quarantined_by_name, u.email AS quarantined_by_email
       FROM quarantined_tests qt
       LEFT JOIN users u ON u.id = qt.quarantined_by`;
    const params: string[] = [];

    if (suite) {
      query += " WHERE qt.suite_name = $1";
      params.push(suite);
    }

    query += " ORDER BY qt.created_at DESC";

    const result = await tenantQuery(req.user!.orgId, query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /quarantine/check — check if specific tests are quarantined (for CI integration)
// Query: ?suite=name&tests=title1,title2 or ?suite=name (returns all for suite)
router.get("/check", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    if (!suite) {
      res.status(400).json({ error: "suite is required" });
      return;
    }

    const result = await tenantQuery(req.user!.orgId,
      "SELECT full_title, file_path FROM quarantined_tests WHERE suite_name = $1",
      [suite]
    );

    res.json({
      quarantined: result.rows.map((r: any) => ({
        full_title: r.full_title,
        file_path: r.file_path,
      })),
    });
  } catch (err) {
    console.error("GET /quarantine/check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /quarantine — quarantine a test
router.post("/", async (req, res) => {
  try {
    const { fullTitle, filePath, suiteName, reason } = req.body;
    if (!fullTitle || !suiteName) {
      res.status(400).json({ error: "fullTitle and suiteName are required" });
      return;
    }

    const orgId = req.user!.orgId;
    const result = await tenantQuery(orgId,
      `INSERT INTO quarantined_tests (org_id, full_title, file_path, suite_name, reason, quarantined_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, full_title, suite_name) DO UPDATE SET reason = $5, quarantined_by = $6, created_at = NOW()
       RETURNING id`,
      [orgId, fullTitle, filePath ?? "", suiteName, reason ?? null, req.user!.id]
    );

    await logAudit(orgId, req.user!.id, "quarantine.add", "test", fullTitle, { suiteName, reason });
    res.status(201).json({ id: result.rows[0].id, quarantined: true });
  } catch (err) {
    console.error("POST /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /quarantine — unquarantine a test
router.delete("/", async (req, res) => {
  try {
    const { fullTitle, suiteName } = req.body;
    if (!fullTitle || !suiteName) {
      res.status(400).json({ error: "fullTitle and suiteName are required" });
      return;
    }

    const orgId = req.user!.orgId;
    await tenantQuery(orgId,
      "DELETE FROM quarantined_tests WHERE full_title = $1 AND suite_name = $2",
      [fullTitle, suiteName]
    );

    await logAudit(orgId, req.user!.id, "quarantine.remove", "test", fullTitle, { suiteName });
    res.json({ quarantined: false });
  } catch (err) {
    console.error("DELETE /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
