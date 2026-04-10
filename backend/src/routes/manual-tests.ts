import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["not_run", "passed", "failed", "blocked", "skipped"];

// GET /manual-tests
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const status = req.query.status as string | undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    if (suite) { params.push(suite); where.push(`suite_name = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT mt.id, mt.suite_name, mt.title, mt.description, mt.priority, mt.status,
              mt.last_run_at, mt.last_run_notes, mt.automated_test_key, mt.tags,
              mt.created_at, mt.updated_at,
              u.email AS last_run_by_email
       FROM manual_tests mt LEFT JOIN users u ON u.id = mt.last_run_by
       ${whereClause}
       ORDER BY mt.updated_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /manual-tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /manual-tests/summary
router.get("/summary", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'passed')::int  AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
         COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
         COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status = 'not_run')::int AS not_run
       FROM manual_tests`
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /manual-tests/summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /manual-tests/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT mt.*, u.email AS last_run_by_email
       FROM manual_tests mt LEFT JOIN users u ON u.id = mt.last_run_by
       WHERE mt.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-tests
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { suite_name, title, description, steps, expected_result, priority, automated_test_key, tags } = req.body;
    if (!title) {
      res.status(400).json({ error: "title required" });
      return;
    }
    const pri = PRIORITIES.includes(priority) ? priority : "medium";

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO manual_tests
        (org_id, suite_name, title, description, steps, expected_result, priority,
         automated_test_key, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        req.user!.orgId,
        suite_name ?? null,
        title,
        description ?? null,
        JSON.stringify(Array.isArray(steps) ? steps : []),
        expected_result ?? null,
        pri,
        automated_test_key ?? null,
        Array.isArray(tags) ? tags : [],
        req.user!.id,
      ]
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.create", "manual_test", String(result.rows[0].id), { title });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /manual-tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /manual-tests/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const body = req.body;

    const assign = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (body.title !== undefined) assign("title", body.title);
    if (body.description !== undefined) assign("description", body.description);
    if (body.suite_name !== undefined) assign("suite_name", body.suite_name);
    if (body.steps !== undefined) assign("steps", JSON.stringify(Array.isArray(body.steps) ? body.steps : []));
    if (body.expected_result !== undefined) assign("expected_result", body.expected_result);
    if (body.priority !== undefined && PRIORITIES.includes(body.priority)) assign("priority", body.priority);
    if (body.automated_test_key !== undefined) assign("automated_test_key", body.automated_test_key);
    if (body.tags !== undefined) assign("tags", Array.isArray(body.tags) ? body.tags : []);

    sets.push(`updated_at = NOW()`);

    if (sets.length === 1) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE manual_tests SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.update", "manual_test", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-tests/:id/result — record an execution outcome
router.post("/:id/result", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { status, notes } = req.body;
    if (!STATUSES.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      `UPDATE manual_tests
         SET status = $1, last_run_at = NOW(), last_run_by = $2,
             last_run_notes = $3, updated_at = NOW()
         WHERE id = $4`,
      [status, req.user!.id, notes ?? null, req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.result", "manual_test", req.params.id, { status });
    res.json({ updated: true, status });
  } catch (err) {
    console.error("POST /manual-tests/:id/result error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /manual-tests/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM manual_tests WHERE id = $1",
      [req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.delete", "manual_test", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
