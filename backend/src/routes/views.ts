import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /views?page=runs
router.get("/", async (req, res) => {
  try {
    const page = req.query.page as string | undefined;
    let query = "SELECT id, name, page, filters, created_at FROM saved_views WHERE user_id = $1";
    const params: unknown[] = [req.user!.id];

    if (page) {
      query += " AND page = $2";
      params.push(page);
    }

    query += " ORDER BY name ASC";

    const result = await tenantQuery(req.user!.orgId, query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /views error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /views
router.post("/", async (req, res) => {
  try {
    const { name, page, filters } = req.body;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const result = await tenantQuery(
      req.user!.orgId,
      "INSERT INTO saved_views (org_id, user_id, name, page, filters) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, page, filters, created_at",
      [req.user!.orgId, req.user!.id, name, page ?? "runs", JSON.stringify(filters ?? {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /views error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /views/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      "DELETE FROM saved_views WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /views/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
