import { Router } from "express";
import { tenantQuery } from "../db.js";
import { verifyAuditChain } from "../audit-chain.js";

const router = Router();

// GET /audit
router.get("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 1000);
    const offset = Number(req.query.offset) || 0;

    // Optional filters, all parameterized (no string interpolation of user
    // input). `action` is an exact match; start_date/end_date bound created_at.
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (typeof req.query.action === "string" && req.query.action !== "") {
      params.push(req.query.action);
      conditions.push(`a.action = $${params.length}`);
    }
    if (typeof req.query.start_date === "string" && req.query.start_date !== "") {
      params.push(req.query.start_date);
      conditions.push(`a.created_at >= $${params.length}`);
    }
    if (typeof req.query.end_date === "string" && req.query.end_date !== "") {
      params.push(req.query.end_date);
      // A date-only end_date (YYYY-MM-DD) casts to midnight, which would
      // exclude events later that same day — surprising when a support agent
      // filters "up to today". Treat date-only as inclusive end-of-day
      // (< next day); a full timestamp is honoured as-is (<=).
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.end_date)) {
        conditions.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
      } else {
        conditions.push(`a.created_at <= $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;

    const result = await tenantQuery(req.user!.orgId, `
      SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
             u.email AS user_email, u.name AS user_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /audit error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /audit/verify — walk this org's audit hash-chain and report integrity.
// Tamper-evidence check (SOC 2 / GovRAMP): proves the audit log hasn't been
// edited, reordered, or had rows deleted since each row was written. Admin+
// only (same gate as GET /audit) — it's a compliance/forensic surface.
router.get("/verify", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const result = await verifyAuditChain(req.user!.orgId);
    // A broken chain is a real, expected report — not a server error. Return
    // 200 with ok:false so clients render the finding; reserve 500 for an
    // actual failure to run the check.
    res.json(result);
  } catch (err) {
    console.error("GET /audit/verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
