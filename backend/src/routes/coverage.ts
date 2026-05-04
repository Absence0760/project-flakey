import { Router } from "express";
import pool, { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// POST /coverage — upload a coverage summary (tied to a run_id)
router.post("/", async (req, res) => {
  try {
    const { run_id, lines_pct, branches_pct, functions_pct, statements_pct, lines_covered, lines_total, files, release } = req.body;
    if (!run_id) {
      res.status(400).json({ error: "run_id required" });
      return;
    }

    // Verify the run belongs to the caller's org via RLS
    const check = await tenantQuery(req.user!.orgId, "SELECT id FROM runs WHERE id = $1", [run_id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Optional: link the run to a release. Mirrors POST /runs's release
    // handling so a coverage-only upload (e.g. instrumented build that
    // re-uploads coverage after the run was already submitted) can still
    // tag the run with FLAKEY_RELEASE.
    const releaseVersion = typeof release === "string" ? release.trim() : "";
    if (releaseVersion) {
      const releaseRes = await tenantQuery(
        req.user!.orgId,
        `INSERT INTO releases (org_id, version)
         VALUES ($1, $2)
         ON CONFLICT (org_id, version) DO UPDATE SET version = EXCLUDED.version
         RETURNING id`,
        [req.user!.orgId, releaseVersion]
      );
      const releaseId = releaseRes.rows[0].id;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_runs (release_id, run_id, org_id, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (release_id, run_id) DO NOTHING`,
        [releaseId, run_id, req.user!.orgId, req.user!.id]
      );
    }

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO coverage_reports
        (org_id, run_id, lines_pct, branches_pct, functions_pct, statements_pct, lines_covered, lines_total, files)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id) DO UPDATE SET
         lines_pct = EXCLUDED.lines_pct,
         branches_pct = EXCLUDED.branches_pct,
         functions_pct = EXCLUDED.functions_pct,
         statements_pct = EXCLUDED.statements_pct,
         lines_covered = EXCLUDED.lines_covered,
         lines_total = EXCLUDED.lines_total,
         files = EXCLUDED.files,
         created_at = NOW()
       RETURNING id, run_id, lines_pct, branches_pct, functions_pct, statements_pct`,
      [
        req.user!.orgId,
        run_id,
        lines_pct ?? null,
        branches_pct ?? null,
        functions_pct ?? null,
        statements_pct ?? null,
        lines_covered ?? null,
        lines_total ?? null,
        files ? JSON.stringify(files) : null,
      ]
    );

    // PR gating: check coverage threshold and post a commit status
    try {
      const orgRow = await pool.query(
        "SELECT coverage_threshold, coverage_gate_enabled FROM organizations WHERE id = $1",
        [req.user!.orgId]
      );
      const threshold = orgRow.rows[0]?.coverage_threshold;
      const gateEnabled = orgRow.rows[0]?.coverage_gate_enabled;
      if (gateEnabled && threshold != null && lines_pct != null) {
        const runRow = await tenantQuery(
          req.user!.orgId,
          "SELECT commit_sha, suite_name FROM runs WHERE id = $1",
          [run_id]
        );
        const commit_sha = runRow.rows[0]?.commit_sha;
        if (commit_sha) {
          const { postCoverageStatus } = await import("../integrations/coverage-gate.js");
          await postCoverageStatus(
            req.user!.orgId,
            commit_sha,
            Number(lines_pct),
            Number(threshold),
            run_id,
            runRow.rows[0]?.suite_name ?? ""
          );
        }
      }
    } catch (err) {
      console.error("Coverage PR gating error:", err);
    }

    await logAudit(req.user!.orgId, req.user!.id, "coverage.upload", "run", String(run_id), { lines_pct, release: releaseVersion || null });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /coverage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /coverage/runs/:runId
router.get("/runs/:runId", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT run_id, lines_pct, branches_pct, functions_pct, statements_pct,
              lines_covered, lines_total, files, created_at
       FROM coverage_reports WHERE run_id = $1`,
      [req.params.runId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "No coverage for run" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /coverage/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /coverage/trend — org-wide trend
router.get("/trend", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const suiteFilter = suite ? "AND r.suite_name = $2" : "";
    const params: unknown[] = [req.user!.orgId];
    if (suite) params.push(suite);

    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT c.run_id, r.suite_name, r.branch, r.commit_sha, r.created_at,
              c.lines_pct, c.branches_pct, c.functions_pct, c.statements_pct
       FROM coverage_reports c JOIN runs r ON r.id = c.run_id
       WHERE c.org_id = $1 ${suiteFilter}
       ORDER BY r.created_at DESC LIMIT 100`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /coverage/trend error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /coverage/settings  — gating configuration
router.get("/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT coverage_threshold, coverage_gate_enabled FROM organizations WHERE id = $1",
      [req.user!.orgId]
    );
    res.json(result.rows[0] ?? {});
  } catch (err) {
    console.error("GET /coverage/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /coverage/settings
router.patch("/settings", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { coverage_threshold, coverage_gate_enabled } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (coverage_threshold !== undefined) {
      const v = coverage_threshold === null || coverage_threshold === ""
        ? null
        : Math.max(0, Math.min(100, Number(coverage_threshold)));
      sets.push(`coverage_threshold = $${i++}`);
      params.push(v);
    }
    if (coverage_gate_enabled !== undefined) {
      sets.push(`coverage_gate_enabled = $${i++}`);
      params.push(!!coverage_gate_enabled);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    params.push(req.user!.orgId);
    await pool.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`, params);
    await logAudit(req.user!.orgId, req.user!.id, "coverage.settings.update", "settings", "coverage");
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /coverage/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
