import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /audit
router.get("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const result = await tenantQuery(req.user!.orgId, `
      SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
             u.email AS user_email, u.name AS user_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /audit error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
