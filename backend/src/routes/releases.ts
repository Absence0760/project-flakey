import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const STATUSES = ["draft", "in_progress", "signed_off", "released", "cancelled"];

const DEFAULT_CHECKLIST: Array<{ label: string; required: boolean }> = [
  { label: "All critical tests passing", required: true },
  { label: "Manual regression test suite executed", required: true },
  { label: "Release notes drafted", required: true },
  { label: "Documentation updated", required: false },
  { label: "Stakeholders notified", required: true },
  { label: "Rollback plan prepared", required: true },
];

// GET /releases
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.version, r.name, r.status, r.target_date, r.description,
              r.signed_off_at, r.created_at, r.updated_at,
              u1.email AS signed_off_by_email,
              u2.email AS created_by_email,
              (SELECT COUNT(*)::int FROM release_checklist_items WHERE release_id = r.id) AS item_count,
              (SELECT COUNT(*)::int FROM release_checklist_items WHERE release_id = r.id AND checked = true) AS checked_count,
              (SELECT COUNT(*)::int FROM release_checklist_items
                  WHERE release_id = r.id AND required = true AND checked = false) AS required_remaining
       FROM releases r
       LEFT JOIN users u1 ON u1.id = r.signed_off_by
       LEFT JOIN users u2 ON u2.id = r.created_by
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /releases error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /releases/:id
router.get("/:id", async (req, res) => {
  try {
    const release = await tenantQuery(
      req.user!.orgId,
      `SELECT r.*, u1.email AS signed_off_by_email, u2.email AS created_by_email
       FROM releases r
       LEFT JOIN users u1 ON u1.id = r.signed_off_by
       LEFT JOIN users u2 ON u2.id = r.created_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (release.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const items = await tenantQuery(
      req.user!.orgId,
      `SELECT ci.id, ci.label, ci.required, ci.checked, ci.position, ci.notes,
              ci.checked_at, u.email AS checked_by_email
       FROM release_checklist_items ci
       LEFT JOIN users u ON u.id = ci.checked_by
       WHERE release_id = $1 ORDER BY position, id`,
      [req.params.id]
    );
    res.json({ ...release.rows[0], items: items.rows });
  } catch (err) {
    console.error("GET /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { version, name, target_date, description, items } = req.body;
    if (!version) {
      res.status(400).json({ error: "version required" });
      return;
    }

    const release = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO releases (org_id, version, name, target_date, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, version, name, status, target_date, description, created_at`,
      [
        req.user!.orgId,
        version,
        name ?? null,
        target_date ?? null,
        description ?? null,
        req.user!.id,
      ]
    );
    const releaseId = release.rows[0].id;

    const checklist = Array.isArray(items) && items.length > 0 ? items : DEFAULT_CHECKLIST;
    let position = 0;
    for (const it of checklist) {
      if (!it?.label) continue;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_checklist_items (org_id, release_id, label, required, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.user!.orgId, releaseId, it.label, it.required !== false, position++]
      );
    }

    await logAudit(req.user!.orgId, req.user!.id, "release.create", "release", String(releaseId), { version });
    res.status(201).json(release.rows[0]);
  } catch (err) {
    console.error("POST /releases error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /releases/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const assign = (c: string, v: unknown) => { sets.push(`${c} = $${i++}`); params.push(v); };

    if (req.body.name !== undefined) assign("name", req.body.name);
    if (req.body.description !== undefined) assign("description", req.body.description);
    if (req.body.target_date !== undefined) assign("target_date", req.body.target_date);
    if (req.body.status !== undefined && STATUSES.includes(req.body.status)) assign("status", req.body.status);
    if (req.body.version !== undefined) assign("version", req.body.version);
    sets.push("updated_at = NOW()");

    if (sets.length === 1) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE releases SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.update", "release", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sign-off
router.post("/:id/sign-off", async (req, res) => {
  try {
    if (req.user!.orgRole !== "owner" && req.user!.orgRole !== "admin") {
      res.status(403).json({ error: "Admin or owner role required" });
      return;
    }
    // Enforce: all required checklist items must be checked
    const remaining = await tenantQuery(
      req.user!.orgId,
      `SELECT COUNT(*)::int AS c FROM release_checklist_items
         WHERE release_id = $1 AND required = true AND checked = false`,
      [req.params.id]
    );
    if (remaining.rows[0].c > 0) {
      res.status(400).json({ error: `${remaining.rows[0].c} required checklist item(s) still unchecked` });
      return;
    }

    await tenantQuery(
      req.user!.orgId,
      `UPDATE releases SET status = 'signed_off', signed_off_by = $1, signed_off_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
      [req.user!.id, req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.sign_off", "release", req.params.id);
    res.json({ signed_off: true });
  } catch (err) {
    console.error("POST /releases/:id/sign-off error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/items
router.post("/:id/items", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { label, required } = req.body;
    if (!label) {
      res.status(400).json({ error: "label required" });
      return;
    }
    const posResult = await tenantQuery(
      req.user!.orgId,
      "SELECT COALESCE(MAX(position) + 1, 0) AS pos FROM release_checklist_items WHERE release_id = $1",
      [req.params.id]
    );
    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO release_checklist_items (org_id, release_id, label, required, position)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.orgId, req.params.id, label, required !== false, posResult.rows[0].pos]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /releases/:id/items error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /releases/:releaseId/items/:itemId — toggle checked / notes
router.patch("/:releaseId/items/:itemId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { checked, notes, label, required } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (checked !== undefined) {
      sets.push(`checked = $${i++}`);
      params.push(!!checked);
      if (checked) {
        sets.push(`checked_by = $${i++}`, `checked_at = NOW()`);
        params.push(req.user!.id);
      } else {
        sets.push(`checked_by = NULL`, `checked_at = NULL`);
      }
    }
    if (notes !== undefined) { sets.push(`notes = $${i++}`); params.push(notes); }
    if (label !== undefined) { sets.push(`label = $${i++}`); params.push(label); }
    if (required !== undefined) { sets.push(`required = $${i++}`); params.push(!!required); }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.itemId, req.params.releaseId);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_checklist_items SET ${sets.join(", ")}
         WHERE id = $${i++} AND release_id = $${i}`,
      params
    );
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH checklist item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:releaseId/items/:itemId
router.delete("/:releaseId/items/:itemId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM release_checklist_items WHERE id = $1 AND release_id = $2",
      [req.params.itemId, req.params.releaseId]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE checklist item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(req.user!.orgId, "DELETE FROM releases WHERE id = $1", [req.params.id]);
    await logAudit(req.user!.orgId, req.user!.id, "release.delete", "release", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
