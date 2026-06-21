import { Router } from "express";
import { tenantQuery } from "../db.js";
import { verifyAuditChain } from "../audit-chain.js";
import {
  isAuditExportEnabled,
  testDelivery,
  type AuditExportConfigRow,
} from "../audit-export.js";
import { encryptSecret } from "../crypto.js";
import { validateWebhookUrl } from "./webhooks.js";
import { logAudit } from "../audit.js";

const router = Router();

// Shared gate for the export-config surface: 404 when the instance kill-switch
// is off (mirrors the SSO flag — the capability simply doesn't exist until an
// operator enables it), 403 for viewers (config holds a delivery secret).
// Returns true if it already sent a response — callers must `return`.
function denyExportAccess(
  req: { user?: { orgRole: string } },
  res: { status: (c: number) => { json: (b: unknown) => void } }
): boolean {
  if (!isAuditExportEnabled()) {
    res.status(404).json({ error: "Audit export is not enabled on this instance" });
    return true;
  }
  if (req.user?.orgRole === "viewer") {
    res.status(403).json({ error: "Admin role required" });
    return true;
  }
  return false;
}

// Client-safe shape: never returns the encrypted token, only whether one is set.
function publicConfig(row: Record<string, unknown>) {
  return {
    id: row.id,
    destination: row.destination,
    enabled: row.enabled,
    endpoint_url: row.endpoint_url,
    auth_header_name: row.auth_header_name,
    auth_token_set: row.auth_token_encrypted != null,
    s3_bucket: row.s3_bucket,
    s3_prefix: row.s3_prefix,
    last_exported_id: row.last_exported_id,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    consecutive_failures: row.consecutive_failures,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// RFC 7230 field-name: a non-empty run of token characters. Validated at the
// request boundary so a bad header name surfaces as a clear 400 instead of
// silently breaking delivery later (undici throws on send → opaque error).
const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Conservative S3 bucket-name shape (DNS label rules). Same rationale: catch it
// here rather than as an opaque "delivery failed" at PutObject time.
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Validate a create/update body for a given destination. Returns an error
// string, or null if valid.
function validateExportBody(
  destination: unknown,
  endpointUrl: unknown,
  authHeaderName: unknown,
  s3Bucket: unknown
): string | null {
  if (destination !== "http" && destination !== "s3") {
    return "destination must be 'http' or 's3'";
  }
  if (destination === "http") {
    const check = validateWebhookUrl(endpointUrl);
    if (!check.ok) return check.error;
    if (
      authHeaderName !== undefined &&
      authHeaderName !== null &&
      (typeof authHeaderName !== "string" || !HTTP_FIELD_NAME.test(authHeaderName))
    ) {
      return "auth_header_name is not a valid HTTP header field-name";
    }
  }
  if (destination === "s3") {
    if (typeof s3Bucket !== "string" || !s3Bucket.trim()) {
      return "s3 destination requires a non-empty s3_bucket";
    }
    if (!S3_BUCKET_NAME.test(s3Bucket)) {
      return "s3_bucket is not a valid bucket name";
    }
  }
  return null;
}

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

// ---- Audit export / SIEM streaming config (admin+, behind the kill-switch) --

// GET /audit/export/status — cheap enablement probe for the UI. Deliberately
// NOT behind denyExportAccess: it must return {enabled:false} (200) when the
// kill-switch is off rather than 404, so the Settings subnav can decide whether
// to render the audit-export link at all without provoking the disabled-state
// round-trip. Any authenticated org member may read it (no secret exposure).
// Registered before "/export" so the literal path can't be shadowed.
router.get("/export/status", (_req, res) => {
  res.json({ enabled: isAuditExportEnabled() });
});

// GET /audit/export — list this org's export destinations (token redacted).
router.get("/export", async (req, res) => {
  if (denyExportAccess(req, res)) return;
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT id, destination, enabled, endpoint_url, auth_header_name,
              auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id,
              last_success_at, last_error, consecutive_failures, created_at, updated_at
       FROM audit_export_config WHERE org_id = $1 ORDER BY id ASC`,
      [req.user!.orgId]
    );
    res.json(result.rows.map(publicConfig));
  } catch (err) {
    console.error("GET /audit/export error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /audit/export — create a destination. New destinations start streaming
// from "now" (the current max audit id) unless `from_beginning` is set, so a
// large existing audit_log isn't dumped in one go by surprise.
router.post("/export", async (req, res) => {
  if (denyExportAccess(req, res)) return;
  try {
    const { destination, endpoint_url, auth_header_name, auth_token, s3_bucket, s3_prefix } =
      req.body ?? {};
    const invalid = validateExportBody(destination, endpoint_url, auth_header_name, s3_bucket);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const enabled = req.body?.enabled === true;
    const tokenEncrypted =
      typeof auth_token === "string" && auth_token !== ""
        ? encryptSecret(auth_token)
        : null;

    // Default cursor: current max audit id for this org (only new events).
    let startId = "0";
    if (req.body?.from_beginning !== true) {
      const max = await tenantQuery(
        req.user!.orgId,
        "SELECT COALESCE(MAX(id), 0) AS max_id FROM audit_log WHERE org_id = $1",
        [req.user!.orgId]
      );
      startId = String(max.rows[0].max_id);
    }

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO audit_export_config
         (org_id, destination, enabled, endpoint_url, auth_header_name,
          auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, destination, enabled, endpoint_url, auth_header_name,
                 auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id,
                 last_success_at, last_error, consecutive_failures, created_at, updated_at`,
      [
        req.user!.orgId,
        destination,
        enabled,
        destination === "http" ? endpoint_url : null,
        destination === "http" ? (auth_header_name ?? null) : null,
        destination === "http" ? tokenEncrypted : null,
        destination === "s3" ? s3_bucket : null,
        destination === "s3" ? (s3_prefix ?? null) : null,
        startId,
      ]
    );
    const row = result.rows[0];
    await logAudit(req.user!.orgId, req.user!.id, "audit.export.create", "audit_export_config",
      String(row.id), { destination, enabled });
    res.status(201).json(publicConfig(row));
  } catch (err) {
    console.error("POST /audit/export error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /audit/export/:id — update a destination. Only the supplied fields
// change; auth_token: a non-empty string rotates it, null clears it, omitted
// leaves it. The destination type is immutable (delete + recreate to change).
router.patch("/export/:id", async (req, res) => {
  if (denyExportAccess(req, res)) return;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const existing = await tenantQuery(
      req.user!.orgId,
      "SELECT * FROM audit_export_config WHERE id = $1 AND org_id = $2",
      [id, req.user!.orgId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Export config not found" });
      return;
    }
    const cur = existing.rows[0];

    // Re-validate against the (immutable) destination using the merged values.
    // Merge by PRESENCE, not nullish-coalescing: an explicit `null` in the body
    // means "set to null", so it must reach validation (which rejects a null
    // required field) — `?? cur` would treat it as "keep current", validate the
    // OLD value, then the SET block below would still write the null, persisting
    // a destination='http'/endpoint_url=NULL config that fails every delivery.
    const body = req.body ?? {};
    const endpointUrl = "endpoint_url" in body ? body.endpoint_url : cur.endpoint_url;
    const authHeaderName = "auth_header_name" in body ? body.auth_header_name : cur.auth_header_name;
    const s3Bucket = "s3_bucket" in body ? body.s3_bucket : cur.s3_bucket;
    const invalid = validateExportBody(cur.destination, endpointUrl, authHeaderName, s3Bucket);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (typeof req.body?.enabled === "boolean") set("enabled", req.body.enabled);
    if (cur.destination === "http") {
      if (req.body?.endpoint_url !== undefined) set("endpoint_url", req.body.endpoint_url);
      if (req.body?.auth_header_name !== undefined) set("auth_header_name", req.body.auth_header_name);
      if (req.body?.auth_token !== undefined) {
        const t = req.body.auth_token;
        set("auth_token_encrypted", typeof t === "string" && t !== "" ? encryptSecret(t) : null);
      }
    }
    if (cur.destination === "s3") {
      if (req.body?.s3_bucket !== undefined) set("s3_bucket", req.body.s3_bucket);
      if (req.body?.s3_prefix !== undefined) set("s3_prefix", req.body.s3_prefix);
    }
    if (sets.length === 0) {
      res.json(publicConfig(cur));
      return;
    }
    sets.push("updated_at = NOW()");
    params.push(id);
    params.push(req.user!.orgId);
    const result = await tenantQuery(
      req.user!.orgId,
      `UPDATE audit_export_config SET ${sets.join(", ")}
       WHERE id = $${params.length - 1} AND org_id = $${params.length}
       RETURNING id, destination, enabled, endpoint_url, auth_header_name,
                 auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id,
                 last_success_at, last_error, consecutive_failures, created_at, updated_at`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "audit.export.update", "audit_export_config",
      String(id), { enabled: result.rows[0].enabled });
    res.json(publicConfig(result.rows[0]));
  } catch (err) {
    console.error("PATCH /audit/export/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /audit/export/:id
router.delete("/export/:id", async (req, res) => {
  if (denyExportAccess(req, res)) return;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await tenantQuery(
      req.user!.orgId,
      "DELETE FROM audit_export_config WHERE id = $1 AND org_id = $2 RETURNING id",
      [id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Export config not found" });
      return;
    }
    await logAudit(req.user!.orgId, req.user!.id, "audit.export.delete", "audit_export_config",
      String(id));
    res.status(204).end();
  } catch (err) {
    console.error("DELETE /audit/export/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /audit/export/:id/test — send one synthetic event to the destination
// without advancing the cursor. Returns { ok, error? } with a SANITIZED error
// (never the raw upstream body / URL / token).
router.post("/export/:id/test", async (req, res) => {
  if (denyExportAccess(req, res)) return;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const found = await tenantQuery(
      req.user!.orgId,
      `SELECT id, org_id, destination, enabled, endpoint_url, auth_header_name,
              auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id
       FROM audit_export_config WHERE id = $1 AND org_id = $2`,
      [id, req.user!.orgId]
    );
    if (found.rows.length === 0) {
      res.status(404).json({ error: "Export config not found" });
      return;
    }
    const result = await testDelivery(found.rows[0] as AuditExportConfigRow);
    await logAudit(req.user!.orgId, req.user!.id, "audit.export.test", "audit_export_config",
      String(id), { ok: result.ok });
    res.json(result);
  } catch (err) {
    console.error("POST /audit/export/:id/test error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
