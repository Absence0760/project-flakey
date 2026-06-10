/**
 * DB + network smoke test for the audit export flusher.
 *
 * Uses an in-process HTTP server as the "SIEM" (no external sink, CI-safe) and
 * drives the real flushConfig path against a throwaway org:
 *   - happy path: pending rows delivered as NDJSON (with chain hashes + auth
 *     header), cursor advances, failures reset.
 *   - failure: a 5xx leaves the cursor put (at-least-once) and records a
 *     SANITIZED last_error — NOT the upstream body (PII/secret-in-logs rule).
 *   - recovery: the held-back row is delivered on the next flush.
 *   - testDelivery: probes without moving the cursor.
 *
 * The instance kill-switch + private-target SSRF guard are flipped on for the
 * test process (the collector is on 127.0.0.1). Needs the local DB.
 */
process.env.FLAKEY_AUDIT_EXPORT_ENABLED = "true";
process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pool, { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { flushConfig, testDelivery, type AuditExportConfigRow } from "../audit-export.js";

const LEAKY_BODY = '{"token":"sk-leaked","host":"db-prod-internal-1"}';

let server: http.Server;
let endpoint = "";
let mode = 200; // toggle to simulate upstream failure
const received: { auth: string | undefined; body: string }[] = [];

let orgId: number;
let configId: number;

async function getConfig(): Promise<AuditExportConfigRow & Record<string, unknown>> {
  const r = await tenantQuery(
    orgId,
    `SELECT id, org_id, destination, enabled, endpoint_url, auth_header_name,
            auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id,
            last_success_at, last_error, consecutive_failures
     FROM audit_export_config WHERE id = $1 AND org_id = $2`,
    [configId, orgId]
  );
  return r.rows[0];
}

async function maxAuditId(): Promise<string> {
  const r = await tenantQuery(
    orgId,
    "SELECT COALESCE(MAX(id), 0) AS m FROM audit_log WHERE org_id = $1",
    [orgId]
  );
  return String(r.rows[0].m);
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ auth: req.headers["authorization"] as string | undefined, body });
      if (mode === 200) {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(mode);
        res.end(LEAKY_BODY);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/collector`;

  const org = await pool.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    ["audit-export", `audit-export-${process.pid}-${Date.now()}`]
  );
  orgId = org.rows[0].id;

  // Plaintext token (no FLAKEY_ENCRYPTION_KEY in tests ⇒ crypto passthrough).
  const cfg = await tenantQuery(
    orgId,
    `INSERT INTO audit_export_config
       (org_id, destination, enabled, endpoint_url, auth_header_name, auth_token_encrypted, last_exported_id)
     VALUES ($1, 'http', true, $2, 'Authorization', $3, 0)
     RETURNING id`,
    [orgId, endpoint, "Bearer test-token"]
  );
  configId = cfg.rows[0].id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (orgId) await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
  await pool.end().catch(() => {});
});

test("happy path: pending rows are delivered and the cursor advances", async () => {
  await logAudit(orgId, null, "test.a", "run", "1", { i: 1 });
  await logAudit(orgId, null, "test.b", "run", "2", { i: 2 });
  const expectedCursor = await maxAuditId();

  await flushConfig(orgId, await getConfig());

  assert.equal(received.length, 1, "one batch delivered");
  assert.equal(received[0].auth, "Bearer test-token", "configured auth header is sent");
  const lines = received[0].body.split("\n");
  assert.equal(lines.length, 2, "both audit rows shipped as NDJSON");
  const first = JSON.parse(lines[0]);
  assert.equal(first.action, "test.a");
  assert.match(first.entry_hash, /^[0-9a-f]{64}$/, "chain hash is included for receiver-side verify");

  const c = await getConfig();
  assert.equal(String(c.last_exported_id), expectedCursor, "cursor advanced to max id");
  assert.equal(c.consecutive_failures, 0);
  assert.equal(c.last_error, null);
  assert.ok(c.last_success_at, "last_success_at set");
});

test("failure: a 5xx holds the cursor and records a sanitized error (no body leak)", async () => {
  const cursorBefore = String((await getConfig()).last_exported_id);
  await logAudit(orgId, null, "test.c", "run", "3", { i: 3 });
  mode = 503;

  await flushConfig(orgId, await getConfig());

  const c = await getConfig();
  assert.equal(String(c.last_exported_id), cursorBefore, "cursor NOT advanced on failure");
  assert.equal(c.consecutive_failures, 1);
  assert.equal(c.last_error, "HTTP 503", "error is the status code only");
  // The upstream body (which carried a fake token + internal hostname) must not
  // be anywhere in the stored error.
  assert.ok(!String(c.last_error).includes("sk-leaked"));
  assert.ok(!String(c.last_error).includes("db-prod-internal-1"));
});

test("recovery: the held-back row is delivered once the receiver is healthy", async () => {
  received.length = 0;
  mode = 200;
  const expectedCursor = await maxAuditId();

  await flushConfig(orgId, await getConfig());

  assert.ok(received.length >= 1, "a batch was delivered on recovery");
  const c = await getConfig();
  assert.equal(String(c.last_exported_id), expectedCursor, "cursor caught up");
  assert.equal(c.consecutive_failures, 0);
  assert.equal(c.last_error, null);
});

test("testDelivery probes without moving the cursor", async () => {
  const cursorBefore = String((await getConfig()).last_exported_id);

  mode = 200;
  const ok = await testDelivery((await getConfig()) as AuditExportConfigRow);
  assert.deepEqual(ok, { ok: true });

  mode = 500;
  const bad = await testDelivery((await getConfig()) as AuditExportConfigRow);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "HTTP 500");

  assert.equal(
    String((await getConfig()).last_exported_id),
    cursorBefore,
    "a test never advances the real cursor"
  );
});
