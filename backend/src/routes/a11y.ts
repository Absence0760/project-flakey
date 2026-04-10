import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// POST /a11y — upload axe-core style report
router.post("/", async (req, res) => {
  try {
    const { run_id, url, violations, passes, incomplete } = req.body;
    if (!run_id) {
      res.status(400).json({ error: "run_id required" });
      return;
    }

    // Verify the run exists in this org
    const check = await tenantQuery(req.user!.orgId, "SELECT id FROM runs WHERE id = $1", [run_id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const viols = Array.isArray(violations) ? violations : [];
    const violationsCount = viols.length;
    const passesCount = Array.isArray(passes) ? passes.length : Number(passes ?? 0);
    const incompleteCount = Array.isArray(incomplete) ? incomplete.length : Number(incomplete ?? 0);

    let critical = 0, serious = 0, moderate = 0, minor = 0;
    for (const v of viols) {
      switch (v?.impact) {
        case "critical": critical++; break;
        case "serious":  serious++; break;
        case "moderate": moderate++; break;
        case "minor":    minor++; break;
      }
    }

    // Score: simple weighted penalty from perfect 100
    const score = Math.max(
      0,
      100 - (critical * 15 + serious * 8 + moderate * 4 + minor * 1)
    );

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO a11y_reports
        (org_id, run_id, url, score, violations_count, violations,
         passes_count, incomplete_count, critical_count, serious_count, moderate_count, minor_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, run_id, url, score, violations_count, critical_count, serious_count, moderate_count, minor_count`,
      [
        req.user!.orgId, run_id, url ?? null, score,
        violationsCount, JSON.stringify(viols),
        passesCount, incompleteCount,
        critical, serious, moderate, minor,
      ]
    );

    await logAudit(req.user!.orgId, req.user!.id, "a11y.upload", "run", String(run_id), { violations: violationsCount, score });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /a11y error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /a11y/runs/:runId — all reports for a run
router.get("/runs/:runId", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT id, url, score, violations_count, violations,
              passes_count, incomplete_count,
              critical_count, serious_count, moderate_count, minor_count,
              created_at
       FROM a11y_reports WHERE run_id = $1 ORDER BY created_at DESC`,
      [req.params.runId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /a11y/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /a11y/trend — last N runs for the org
router.get("/trend", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT a.run_id, a.url, a.score, a.violations_count,
              a.critical_count, a.serious_count, a.moderate_count, a.minor_count,
              r.suite_name, r.branch, r.created_at
       FROM a11y_reports a JOIN runs r ON r.id = a.run_id
       WHERE a.org_id = $1
       ORDER BY r.created_at DESC LIMIT 200`,
      [req.user!.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /a11y/trend error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
