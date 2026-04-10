import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// POST /ui-coverage/visits — record URLs/routes that tests visited
router.post("/visits", async (req, res) => {
  try {
    const { suite_name, run_id, visits } = req.body;
    if (!suite_name || !Array.isArray(visits)) {
      res.status(400).json({ error: "suite_name and visits[] required" });
      return;
    }
    for (const v of visits) {
      const route = typeof v === "string" ? v : v?.route_pattern;
      if (!route) continue;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO ui_coverage (org_id, suite_name, route_pattern, last_run_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, suite_name, route_pattern) DO UPDATE SET
             visit_count = ui_coverage.visit_count + 1,
             last_seen   = NOW(),
             last_run_id = EXCLUDED.last_run_id`,
        [req.user!.orgId, suite_name, route, run_id ?? null]
      );
    }
    res.status(201).json({ recorded: visits.length });
  } catch (err) {
    console.error("POST /ui-coverage/visits error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ui-coverage — covered routes
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const params: unknown[] = [req.user!.orgId];
    const suiteClause = suite ? "AND suite_name = $2" : "";
    if (suite) params.push(suite);
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT suite_name, route_pattern, visit_count, first_seen, last_seen, last_run_id
       FROM ui_coverage WHERE org_id = $1 ${suiteClause}
       ORDER BY last_seen DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /ui-coverage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ui-coverage/untested — known routes with no visits
router.get("/untested", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT kr.route_pattern, kr.label, kr.source, kr.created_at
       FROM ui_known_routes kr
       LEFT JOIN ui_coverage uc
         ON uc.org_id = kr.org_id AND uc.route_pattern = kr.route_pattern
       WHERE kr.org_id = $1 AND uc.id IS NULL
       ORDER BY kr.route_pattern`,
      [req.user!.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /ui-coverage/untested error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ui-coverage/summary — overall coverage %
router.get("/summary", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT
         (SELECT COUNT(*)::int FROM ui_known_routes WHERE org_id = $1) AS known_routes,
         (SELECT COUNT(DISTINCT route_pattern)::int FROM ui_coverage WHERE org_id = $1) AS visited_routes,
         (SELECT COUNT(*)::int FROM ui_known_routes kr
            WHERE kr.org_id = $1 AND EXISTS (
              SELECT 1 FROM ui_coverage uc
              WHERE uc.org_id = kr.org_id AND uc.route_pattern = kr.route_pattern
            )) AS known_covered`,
      [req.user!.orgId]
    );
    const row = result.rows[0];
    const pct = row.known_routes > 0 ? Math.round((row.known_covered / row.known_routes) * 1000) / 10 : null;
    res.json({ ...row, coverage_pct: pct });
  } catch (err) {
    console.error("GET /ui-coverage/summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /ui-coverage/routes — add known route(s)
router.post("/routes", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { routes } = req.body;
    if (!Array.isArray(routes)) {
      res.status(400).json({ error: "routes[] required" });
      return;
    }
    let added = 0;
    for (const r of routes) {
      const pattern = typeof r === "string" ? r : r?.route_pattern;
      if (!pattern) continue;
      const label = typeof r === "object" ? r?.label ?? null : null;
      const source = typeof r === "object" ? r?.source ?? null : null;
      const result = await tenantQuery(
        req.user!.orgId,
        `INSERT INTO ui_known_routes (org_id, route_pattern, label, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, route_pattern) DO NOTHING RETURNING id`,
        [req.user!.orgId, pattern, label, source]
      );
      if (result.rows.length > 0) added++;
    }
    await logAudit(req.user!.orgId, req.user!.id, "ui_coverage.routes.add", "ui_known_routes", undefined, { added });
    res.status(201).json({ added });
  } catch (err) {
    console.error("POST /ui-coverage/routes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /ui-coverage/routes/:pattern — remove known route
router.delete("/routes/:pattern", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM ui_known_routes WHERE route_pattern = $1",
      [decodeURIComponent(req.params.pattern)]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /ui-coverage/routes/:pattern error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
