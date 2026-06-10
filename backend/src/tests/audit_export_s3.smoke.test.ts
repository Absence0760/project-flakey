/**
 * DB-backed test for the S3 audit-export delivery path (previously uncovered —
 * the other export tests only exercised the HTTP destination).
 *
 * Patches S3Client.prototype.send so no real S3/MinIO is needed: asserts the
 * PutObject key/body/content-type, the cursor advance on success, and that a
 * PutObject failure holds the cursor + records a sanitized error (same contract
 * as the HTTP 5xx path). Needs the local DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import pool, { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { flushConfig, type AuditExportConfigRow } from "../audit-export.js";

let orgId: number;
let configId: number;
const sent: Array<{ Bucket?: string; Key?: string; Body?: unknown; ContentType?: string }> = [];
let mode: "ok" | "throw" = "ok";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalSend = (S3Client.prototype as any).send;

before(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (S3Client.prototype as any).send = async function (cmd: { input: Record<string, unknown> }) {
    sent.push(cmd.input as never);
    if (mode === "throw") {
      const e = Object.assign(new Error("socket hang up"), { code: "ECONNREFUSED" });
      throw e;
    }
    return {};
  };

  const org = await pool.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    ["audit-s3", `audit-s3-${process.pid}-${Date.now()}`]
  );
  orgId = org.rows[0].id;
  const cfg = await tenantQuery(
    orgId,
    `INSERT INTO audit_export_config (org_id, destination, enabled, s3_bucket, s3_prefix, last_exported_id)
     VALUES ($1, 's3', true, 'audit-bucket', 'logs/x', 0) RETURNING id`,
    [orgId]
  );
  configId = cfg.rows[0].id;
});

after(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (S3Client.prototype as any).send = originalSend;
  if (orgId) await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
  await pool.end().catch(() => {});
});

async function getConfig(): Promise<AuditExportConfigRow & Record<string, unknown>> {
  const r = await tenantQuery(
    orgId,
    `SELECT id, org_id, destination, enabled, endpoint_url, auth_header_name,
            auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id,
            last_error, consecutive_failures
     FROM audit_export_config WHERE id = $1 AND org_id = $2`,
    [configId, orgId]
  );
  return r.rows[0];
}
async function maxAuditId(): Promise<string> {
  const r = await tenantQuery(orgId, "SELECT COALESCE(MAX(id),0) AS m FROM audit_log WHERE org_id = $1", [orgId]);
  return String(r.rows[0].m);
}

test("s3 delivery writes an NDJSON object under the right key and advances the cursor", async () => {
  await logAudit(orgId, null, "s3.a", "run", "1", { i: 1 });
  await logAudit(orgId, null, "s3.b", "run", "2", { i: 2 });
  const expected = await maxAuditId();

  await flushConfig(orgId, await getConfig());

  assert.equal(sent.length, 1, "one PutObject");
  const put = sent[0];
  assert.equal(put.Bucket, "audit-bucket");
  assert.match(put.Key as string, /^logs\/x\/audit\/org-\d+\/\d+-\d+\.ndjson$/, "key layout");
  assert.equal(put.ContentType, "application/x-ndjson");
  const lines = String(put.Body).split("\n");
  assert.equal(lines.length, 2, "both rows in the NDJSON body");
  assert.equal(JSON.parse(lines[0]).action, "s3.a");
  assert.match(JSON.parse(lines[0]).entry_hash, /^[0-9a-f]{64}$/, "chain hash included");

  const c = await getConfig();
  assert.equal(String(c.last_exported_id), expected, "cursor advanced");
  assert.equal(c.consecutive_failures, 0);
});

test("an s3 PutObject failure holds the cursor and records a sanitized error", async () => {
  const cursorBefore = String((await getConfig()).last_exported_id);
  await logAudit(orgId, null, "s3.c", "run", "3", { i: 3 });
  mode = "throw";

  await flushConfig(orgId, await getConfig());

  const c = await getConfig();
  assert.equal(String(c.last_exported_id), cursorBefore, "cursor NOT advanced on failure");
  assert.equal(c.consecutive_failures, 1);
  assert.equal(c.last_error, "connection error (ECONNREFUSED)", "sanitized, no raw message");
  mode = "ok";
});
