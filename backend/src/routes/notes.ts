import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_TARGET_TYPES = ["run", "test", "error"];

// GET /notes?target_type=run&target_key=42
router.get("/", async (req, res) => {
  try {
    const targetType = req.query.target_type as string;
    const targetKey = req.query.target_key as string;

    if (!targetType || !targetKey || !VALID_TARGET_TYPES.includes(targetType)) {
      res.status(400).json({ error: "target_type and target_key are required" });
      return;
    }

    const result = await tenantQuery(req.user!.orgId,
      `SELECT n.id, n.body, n.target_type, n.target_key, n.created_at,
              u.name AS user_name, u.email AS user_email
       FROM notes n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.target_type = $1 AND n.target_key = $2
       ORDER BY n.created_at ASC`,
      [targetType, targetKey]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /notes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /notes/counts?target_type=run&target_keys=1,2,3
router.get("/counts", async (req, res) => {
  try {
    const targetType = req.query.target_type as string;
    const targetKeys = (req.query.target_keys as string)?.split(",").filter(Boolean);

    if (!targetType || !targetKeys?.length || !VALID_TARGET_TYPES.includes(targetType)) {
      res.status(400).json({ error: "target_type and target_keys are required" });
      return;
    }

    const result = await tenantQuery(req.user!.orgId,
      `SELECT target_key, COUNT(*)::int AS count
       FROM notes
       WHERE target_type = $1 AND target_key = ANY($2)
       GROUP BY target_key`,
      [targetType, targetKeys]
    );

    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.target_key] = row.count;
    }
    res.json(counts);
  } catch (err) {
    console.error("GET /notes/counts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /notes
router.post("/", async (req, res) => {
  try {
    const { target_type, target_key, body } = req.body;

    if (!target_type || !target_key || !VALID_TARGET_TYPES.includes(target_type)) {
      res.status(400).json({ error: "target_type and target_key are required" });
      return;
    }
    if (!body?.trim()) {
      res.status(400).json({ error: "Note body is required" });
      return;
    }

    const orgId = req.user!.orgId;

    const result = await tenantQuery(orgId,
      `INSERT INTO notes (org_id, user_id, target_type, target_key, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [orgId, req.user!.id, target_type, target_key, body.trim()]
    );

    await logAudit(orgId, req.user!.id, "note.create", target_type, target_key);

    res.status(201).json({
      id: result.rows[0].id,
      body: body.trim(),
      target_type,
      target_key,
      created_at: result.rows[0].created_at,
      user_name: req.user!.name,
      user_email: req.user!.email,
    });
  } catch (err) {
    console.error("POST /notes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
