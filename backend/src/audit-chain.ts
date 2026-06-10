import crypto from "crypto";
import { tenantQuery } from "./db.js";

/**
 * Tamper-evidence for the audit log (SOC 2 / GovRAMP integrity control).
 *
 * Each audit row stores `prev_hash` (the previous hashed row's entry_hash, in
 * chain order) and `entry_hash = SHA-256(prev_hash || canonical(content))`.
 * Any later edit, delete, or reorder of audit rows breaks the chain and is
 * detected by `verifyAuditChain` — recomputed hashes stop matching, or a
 * surviving row's prev_hash no longer links to its predecessor.
 *
 * On its own this detects in-place tampering. Combined with the export pipeline
 * (src/audit-export.ts), which ships entry_hash to an off-box SIEM, it becomes
 * full tamper-evidence: a later DB rewrite can re-chain the local table, but it
 * can't change the hashes already attested off-box.
 *
 * Chain order is `id` alone (BIGSERIAL). Appends are serialized per org by a
 * transaction-scoped advisory lock (see audit.ts), and the id is assigned by
 * the INSERT *while holding that lock*, so an org's ids strictly increase in
 * append order — id IS the chain order. created_at is deliberately NOT part of
 * the order: it defaults to transaction_timestamp (fixed at BEGIN, before the
 * lock), so two concurrent appends can have created_at inverted relative to the
 * lock/append order — ordering by it would false-break the chain. (created_at
 * is still hashed into each row as content; it's just not the sort key.) Both
 * the predecessor lookup (ORDER BY id DESC LIMIT 1) and the verify keyset walk
 * (id > cursor ORDER BY id ASC) are served by idx_audit_log_org_id
 * (org_id, id) — migration 065.
 */

// Predecessor hash for the first hashed row in an org's chain.
export const GENESIS_HASH = "0".repeat(64);

// Advisory-lock namespace for serializing per-org chain appends. Two-int form
// pg_advisory_xact_lock(CLASS, orgId) — same pattern as integrations/jira.ts.
// CLASS fits in int4 and is distinct from other advisory-lock keys in the app.
export const AUDIT_CHAIN_LOCK_CLASS = 0x41554443; // "AUDC"

export interface AuditChainFields {
  id: number | string; // bigint (audit_log.id)
  orgId: number;
  userId: number | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown; // the jsonb value as stored (object | array | scalar | null)
  createdAt: string; // ISO 8601, from the DB-stored created_at
}

/**
 * Deterministic JSON with recursively sorted object keys, so the hash is
 * independent of key order. jsonb does NOT preserve key order across the DB
 * round-trip, so append and verify both canonicalize before hashing.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/**
 * entry_hash for one row. The bound field set + order MUST match between the
 * append path (audit.ts) and verify — changing it invalidates every existing
 * chain, so treat it as a versioned contract.
 *
 * Note: `detail` is canonicalized to a string and then placed into the outer
 * array, where canonicalJson re-encodes it as a JSON string value — i.e. detail
 * is intentionally double-encoded. It's internally consistent (append and
 * verify both do this, so no false breaks), but anyone reproducing the hash
 * outside this codebase must mirror it.
 */
export function computeEntryHash(prevHash: string, f: AuditChainFields): string {
  const canonical = canonicalJson([
    String(f.id),
    f.orgId,
    f.userId,
    f.action,
    f.targetType,
    f.targetId,
    canonicalJson(f.detail),
    f.createdAt,
  ]);
  return crypto.createHash("sha256").update(prevHash + "\n" + canonical, "utf8").digest("hex");
}

export interface AuditVerifyResult {
  ok: boolean;
  totalRows: number;
  legacyRows: number; // leading rows with NULL entry_hash (predate the feature; not part of the chain)
  hashedRows: number; // rows actually covered by the chain
  firstBrokenId: string | null; // id of the first row that fails to verify
  reason: string | null; // human-readable failure cause when ok === false
}

/**
 * Walk an org's audit chain and report integrity. Read-only.
 *
 * Legacy rows (NULL entry_hash) that predate the migration form a leading
 * prefix and are counted, not verified. Once the first hashed row is seen,
 * every later row must be hashed and must link — a NULL hash after that point
 * is itself evidence of tampering (a hash was cleared).
 */
export async function verifyAuditChain(
  orgId: number,
  opts?: { batchSize?: number }
): Promise<AuditVerifyResult> {
  const batchSize = opts?.batchSize ?? 1000;
  let totalRows = 0;
  let legacyRows = 0;
  let hashedRows = 0;
  let started = false; // have we reached the first hashed row?
  let expectedPrev = GENESIS_HASH;

  // Keyset pagination on id alone — the chain order (see header). Comparing a
  // single bigint cursor avoids the lossy round-trip of created_at through a
  // millisecond-precision JS Date (which truncated microseconds and re-read the
  // boundary row, falsely reporting tamper on logs larger than batchSize rows).
  let lastId: string | null = null;

  for (;;) {
    // Explicit org_id predicate (not just RLS): defense-in-depth for a
    // compliance control, and with idx_audit_log_org_id (org_id, id) it seeks
    // this org's partition for the id-ordered walk instead of scanning.
    const params: unknown[] = [orgId];
    let keyset = "";
    if (lastId !== null) {
      params.push(lastId);
      keyset = `AND a.id > $2`;
    }
    params.push(batchSize);
    const { rows } = await tenantQuery(
      orgId,
      `SELECT a.id, a.org_id, a.user_id, a.action, a.target_type, a.target_id,
              a.detail, a.created_at, a.prev_hash, a.entry_hash
       FROM audit_log a
       WHERE a.org_id = $1
       ${keyset}
       ORDER BY a.id ASC
       LIMIT $${params.length}`,
      params
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      totalRows++;
      lastId = String(row.id);

      if (!row.entry_hash) {
        if (started) {
          return broken(totalRows, legacyRows, hashedRows, String(row.id),
            "entry_hash is NULL on a row inside the hashed chain (a hash was cleared)");
        }
        legacyRows++;
        continue;
      }

      // First hashed row: its prev_hash must be GENESIS (or it links to the
      // last legacy row's — but legacy rows have no hash, so the chain starts
      // at GENESIS). Subsequent rows must link to the running head.
      const prev = row.prev_hash ?? "";
      if (prev !== expectedPrev) {
        return broken(totalRows, legacyRows, hashedRows, String(row.id),
          "prev_hash does not link to the previous entry (row deleted, reordered, or inserted)");
      }
      const recomputed = computeEntryHash(prev, {
        id: row.id,
        orgId: row.org_id,
        userId: row.user_id ?? null,
        action: row.action,
        targetType: row.target_type ?? null,
        targetId: row.target_id ?? null,
        detail: row.detail,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (recomputed !== row.entry_hash) {
        return broken(totalRows, legacyRows, hashedRows, String(row.id),
          "entry_hash does not match the row content (the row was modified)");
      }
      started = true;
      hashedRows++;
      expectedPrev = row.entry_hash;
    }

    if (rows.length < batchSize) break;
  }

  return { ok: true, totalRows, legacyRows, hashedRows, firstBrokenId: null, reason: null };
}

function broken(
  totalRows: number,
  legacyRows: number,
  hashedRows: number,
  firstBrokenId: string,
  reason: string
): AuditVerifyResult {
  return { ok: false, totalRows, legacyRows, hashedRows, firstBrokenId, reason };
}
