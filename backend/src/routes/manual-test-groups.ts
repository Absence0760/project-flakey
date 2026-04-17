import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

// GET /manual-test-groups — list with test counts
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
              u.email AS created_by_email,
              COALESCE(c.test_count, 0)::int AS test_count
         FROM manual_test_groups g
         LEFT JOIN users u ON u.id = g.created_by
         LEFT JOIN (
           SELECT group_id, COUNT(*)::int AS test_count
             FROM manual_tests
            WHERE group_id IS NOT NULL
            GROUP BY group_id
         ) c ON c.group_id = g.id
        ORDER BY g.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /manual-test-groups error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /manual-test-groups/:id — single group with members
router.get("/:id", async (req, res) => {
  try {
    const group = await tenantQuery(
      req.user!.orgId,
      `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
              u.email AS created_by_email
         FROM manual_test_groups g
         LEFT JOIN users u ON u.id = g.created_by
        WHERE g.id = $1`,
      [req.params.id]
    );
    if (group.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const tests = await tenantQuery(
      req.user!.orgId,
      `SELECT id, title, suite_name, priority, status
         FROM manual_tests
        WHERE group_id = $1
        ORDER BY priority DESC, title`,
      [req.params.id]
    );
    res.json({ ...group.rows[0], tests: tests.rows });
  } catch (err) {
    console.error("GET /manual-test-groups/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-test-groups
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { name, description } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO manual_test_groups (org_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, created_at, updated_at`,
      [req.user!.orgId, name.trim(), description ?? null, req.user!.id]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test_group.create",
      "manual_test_group",
      String(result.rows[0].id),
      { name: name.trim() }
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A group with that name already exists" });
      return;
    }
    console.error("POST /manual-test-groups error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /manual-test-groups/:id — rename / update description
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      sets.push(`name = $${i++}`);
      params.push(req.body.name.trim());
    }
    if (req.body.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(req.body.description);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    sets.push("updated_at = NOW()");
    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE manual_test_groups SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test_group.update",
      "manual_test_group",
      req.params.id
    );
    res.json({ updated: true });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A group with that name already exists" });
      return;
    }
    console.error("PATCH /manual-test-groups/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /manual-test-groups/:id — sets group_id=NULL on members via FK
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM manual_test_groups WHERE id = $1",
      [req.params.id]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test_group.delete",
      "manual_test_group",
      req.params.id
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /manual-test-groups/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
