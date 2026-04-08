import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// GET /suites
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(req.user!.orgId, `
      SELECT r.suite_name, COUNT(*)::int AS run_count, MAX(r.created_at) AS last_run,
             COALESCE(so.archived, false) AS archived,
             so.rerun_command_template
      FROM runs r
      LEFT JOIN suite_overrides so ON so.suite_name = r.suite_name AND so.org_id = r.org_id
      GROUP BY r.suite_name, so.archived, so.rerun_command_template
      ORDER BY last_run DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /suites error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /suites/:name/rename
router.patch("/:name/rename", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { new_name } = req.body;
    if (!new_name) {
      res.status(400).json({ error: "new_name is required" });
      return;
    }
    const oldName = decodeURIComponent(req.params.name);
    await tenantQuery(req.user!.orgId, "UPDATE runs SET suite_name = $1 WHERE suite_name = $2", [new_name, oldName]);
    await tenantQuery(req.user!.orgId,
      "UPDATE suite_overrides SET suite_name = $1 WHERE suite_name = $2",
      [new_name, oldName]
    );
    await logAudit(req.user!.orgId, req.user!.id, "suite.rename", "suite", new_name, { old_name: oldName, new_name });
    res.json({ renamed: true });
  } catch (err) {
    console.error("PATCH /suites/:name/rename error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /suites/:name/archive
router.patch("/:name/archive", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const suiteName = decodeURIComponent(req.params.name);
    const archived = req.body.archived !== false;
    await tenantQuery(req.user!.orgId,
      `INSERT INTO suite_overrides (org_id, suite_name, archived) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, suite_name) DO UPDATE SET archived = $3`,
      [req.user!.orgId, suiteName, archived]
    );
    await logAudit(req.user!.orgId, req.user!.id, archived ? "suite.archive" : "suite.unarchive", "suite", suiteName);
    res.json({ archived });
  } catch (err) {
    console.error("PATCH /suites/:name/archive error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /suites/:name/rerun-template
router.patch("/:name/rerun-template", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const suiteName = decodeURIComponent(req.params.name);
    const { template } = req.body;
    if (typeof template !== "string") {
      res.status(400).json({ error: "template is required" });
      return;
    }
    await tenantQuery(req.user!.orgId,
      `INSERT INTO suite_overrides (org_id, suite_name, rerun_command_template) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, suite_name) DO UPDATE SET rerun_command_template = $3`,
      [req.user!.orgId, suiteName, template || null]
    );
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /suites/:name/rerun-template error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /suites/:name
router.delete("/:name", async (req, res) => {
  try {
    if (req.user!.orgRole !== "owner") {
      res.status(403).json({ error: "Owner role required to delete suites" });
      return;
    }
    const suiteName = decodeURIComponent(req.params.name);
    const result = await tenantQuery(req.user!.orgId,
      "DELETE FROM runs WHERE suite_name = $1 RETURNING id",
      [suiteName]
    );
    await tenantQuery(req.user!.orgId, "DELETE FROM suite_overrides WHERE suite_name = $1", [suiteName]);
    await logAudit(req.user!.orgId, req.user!.id, "suite.delete", "suite", suiteName, { deleted_runs: result.rows.length });
    res.json({ deleted: true, runs_deleted: result.rows.length });
  } catch (err) {
    console.error("DELETE /suites/:name error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
