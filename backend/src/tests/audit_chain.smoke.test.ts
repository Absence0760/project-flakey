/**
 * DB-backed tamper-evidence tests for the audit hash-chain.
 *
 * Exercises the real append path (logAudit → chain) and verifyAuditChain
 * against a throwaway org, then induces the three tamper classes the chain
 * exists to catch:
 *   1. content edit   — UPDATE a row's detail            → recompute mismatch
 *   2. deleted row    — DELETE a middle row              → prev_hash link break
 *   3. cleared hash   — NULL a hash inside the chain     → hole in the chain
 * Plus the legacy-prefix case (rows that predate the feature carry NULL hashes
 * and are counted, not verified).
 *
 * Needs the local DB (db.js defaults to flakey_app/flakey). organizations has
 * no RLS, so a throwaway org is created directly; audit rows cascade-delete with
 * it on cleanup. Tamper writes go through tenantQuery so RLS is satisfied —
 * the same path an attacker with app-level DB access would have.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pool, { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { verifyAuditChain } from "../audit-chain.js";

const createdOrgIds: number[] = [];

async function freshOrg(label: string): Promise<number> {
  const slug = `audit-chain-${label}-${process.pid}-${Date.now()}`;
  const r = await pool.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`audit-chain ${label}`, slug]
  );
  const id = r.rows[0].id as number;
  createdOrgIds.push(id);
  return id;
}

async function rowIds(orgId: number): Promise<string[]> {
  const r = await tenantQuery(
    orgId,
    "SELECT id FROM audit_log WHERE org_id = $1 ORDER BY created_at ASC, id ASC",
    [orgId]
  );
  return r.rows.map((x) => String(x.id));
}

after(async () => {
  for (const id of createdOrgIds) {
    await pool.query("DELETE FROM organizations WHERE id = $1", [id]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

test("a freshly written chain verifies clean", async () => {
  const org = await freshOrg("clean");
  await logAudit(org, null, "test.a", "run", "1", { i: 1 });
  await logAudit(org, null, "test.b", "run", "2", { i: 2 });
  await logAudit(org, null, "test.c", "run", "3", { nested: { z: 1, a: 2 } });

  const v = await verifyAuditChain(org);
  assert.equal(v.ok, true, v.reason ?? "expected a clean chain");
  assert.equal(v.totalRows, 3);
  assert.equal(v.hashedRows, 3);
  assert.equal(v.legacyRows, 0);
  assert.equal(v.firstBrokenId, null);
});

test("editing a row's content is detected (recompute mismatch)", async () => {
  const org = await freshOrg("edit");
  await logAudit(org, null, "test.a", "run", "1", { i: 1 });
  await logAudit(org, null, "test.b", "run", "2", { i: 2 });
  await logAudit(org, null, "test.c", "run", "3", { i: 3 });
  const ids = await rowIds(org);

  // Tamper with the middle row's detail in place — hash now no longer matches.
  await tenantQuery(
    org,
    `UPDATE audit_log SET detail = '{"i":999}'::jsonb WHERE id = $1`,
    [ids[1]]
  );

  const v = await verifyAuditChain(org);
  assert.equal(v.ok, false);
  assert.equal(v.firstBrokenId, ids[1]);
  assert.match(v.reason ?? "", /modified|content/i);
});

test("deleting a middle row is detected (prev_hash link break)", async () => {
  const org = await freshOrg("delete");
  await logAudit(org, null, "test.a", "run", "1", { i: 1 });
  await logAudit(org, null, "test.b", "run", "2", { i: 2 });
  await logAudit(org, null, "test.c", "run", "3", { i: 3 });
  const ids = await rowIds(org);

  await tenantQuery(org, "DELETE FROM audit_log WHERE id = $1", [ids[1]]);

  const v = await verifyAuditChain(org);
  assert.equal(v.ok, false);
  // The row AFTER the deleted one no longer links to the running head.
  assert.equal(v.firstBrokenId, ids[2]);
  assert.match(v.reason ?? "", /link|deleted|reorder/i);
});

test("clearing a hash inside the chain is detected", async () => {
  const org = await freshOrg("clearhash");
  await logAudit(org, null, "test.a", "run", "1", { i: 1 });
  await logAudit(org, null, "test.b", "run", "2", { i: 2 });
  const ids = await rowIds(org);

  await tenantQuery(org, "UPDATE audit_log SET entry_hash = NULL WHERE id = $1", [ids[1]]);

  const v = await verifyAuditChain(org);
  assert.equal(v.ok, false);
  assert.equal(v.firstBrokenId, ids[1]);
});

test("legacy rows (pre-feature NULL hashes) form a counted prefix, not a break", async () => {
  const org = await freshOrg("legacy");
  // Simulate a row written before the tamper-evidence feature landed: present
  // in audit_log but with no chain hashes.
  await tenantQuery(
    org,
    `INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, detail)
     VALUES ($1, NULL, 'legacy.row', 'run', '0', NULL)`,
    [org]
  );
  // Then real, hashed appends.
  await logAudit(org, null, "test.a", "run", "1", { i: 1 });
  await logAudit(org, null, "test.b", "run", "2", { i: 2 });

  const v = await verifyAuditChain(org);
  assert.equal(v.ok, true, v.reason ?? "legacy prefix must not break the chain");
  assert.equal(v.totalRows, 3);
  assert.equal(v.legacyRows, 1);
  assert.equal(v.hashedRows, 2);
});
