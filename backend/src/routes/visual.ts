import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_STATUSES = ["pending", "approved", "rejected", "changed", "new", "unchanged"];

// POST /visual — upload a batch of visual diff records (paths should already
// be stored as static files via /runs/upload, we just store references).
router.post("/", async (req, res) => {
  try {
    const { run_id, diffs } = req.body;
    if (!run_id || !Array.isArray(diffs)) {
      res.status(400).json({ error: "run_id and diffs[] required" });
      return;
    }

    const check = await tenantQuery(req.user!.orgId, "SELECT id FROM runs WHERE id = $1", [run_id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const created: unknown[] = [];
    for (const d of diffs) {
      if (!d?.name) continue;
      const status = VALID_STATUSES.includes(d.status) ? d.status : "pending";
      const r = await tenantQuery(
        req.user!.orgId,
        `INSERT INTO visual_diffs
          (org_id, run_id, test_id, name, baseline_path, current_path, diff_path, diff_pct, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, name, status, diff_pct`,
        [
          req.user!.orgId,
          run_id,
          d.test_id ?? null,
          d.name,
          d.baseline_path ?? null,
          d.current_path ?? null,
          d.diff_path ?? null,
          d.diff_pct ?? null,
          status,
        ]
      );
      created.push(r.rows[0]);
    }

    await logAudit(req.user!.orgId, req.user!.id, "visual.upload", "run", String(run_id), { count: created.length });
    res.status(201).json({ created });
  } catch (err) {
    console.error("POST /visual error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /visual/runs/:runId
router.get("/runs/:runId", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT v.id, v.name, v.baseline_path, v.current_path, v.diff_path, v.diff_pct,
              v.status, v.reviewed_at, v.created_at,
              u.email AS reviewed_by_email
       FROM visual_diffs v LEFT JOIN users u ON u.id = v.reviewed_by
       WHERE v.run_id = $1 ORDER BY v.status, v.diff_pct DESC NULLS LAST`,
      [req.params.runId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /visual/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /visual/pending — all pending across the org
router.get("/pending", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT v.id, v.run_id, v.name, v.diff_path, v.diff_pct, v.created_at,
              r.suite_name, r.branch
       FROM visual_diffs v JOIN runs r ON r.id = v.run_id
       WHERE v.status IN ('pending','changed','new')
       ORDER BY v.created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /visual/pending error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /visual/:id  — approve/reject/update status
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      `UPDATE visual_diffs
         SET status = $1, reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $3`,
      [status, req.user!.id, req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "visual.review", "visual_diff", req.params.id, { status });
    res.json({ updated: true, status });
  } catch (err) {
    console.error("PATCH /visual/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
