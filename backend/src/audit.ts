import { tenantTransaction } from "./db.js";
import {
  AUDIT_CHAIN_LOCK_CLASS,
  GENESIS_HASH,
  computeEntryHash,
} from "./audit-chain.js";

export async function logAudit(
  orgId: number,
  userId: number | null,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: object
): Promise<void> {
  try {
    // Append into the per-org hash chain (tamper-evidence — see audit-chain.ts).
    // A transaction-scoped advisory lock serializes appends for this org so the
    // chain has a single well-defined head: two concurrent audits can't both
    // read the same predecessor and fork the chain. The lock is released on
    // COMMIT/ROLLBACK. RLS applies inside tenantTransaction (app.current_org_id
    // is set), so the INSERT/SELECT are tenant-scoped.
    await tenantTransaction(orgId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        AUDIT_CHAIN_LOCK_CLASS,
        orgId,
      ]);

      // Predecessor = the org's last hashed row in CHAIN order, which is id
      // order: the id (BIGSERIAL) is assigned by this INSERT while holding the
      // advisory lock, so under the lock an org's ids strictly increase in
      // append order. Do NOT order by created_at — it's transaction_timestamp,
      // fixed at BEGIN before the lock, so two concurrent appends can invert
      // created_at vs the actual append order and fork/false-break the chain.
      const prev = await client.query(
        `SELECT entry_hash FROM audit_log
         WHERE org_id = $1 AND entry_hash IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
        [orgId]
      );
      const prevHash: string = prev.rows[0]?.entry_hash ?? GENESIS_HASH;

      // Insert first, then hash the DB-authoritative row (its id, the stored
      // jsonb detail, and the DB-assigned created_at) so verify recomputes the
      // exact same bytes. The row is invisible to other sessions until COMMIT,
      // and the advisory lock guarantees the next append sees this entry_hash.
      const ins = await client.query(
        `INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, detail, prev_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at, detail`,
        [
          orgId,
          userId,
          action,
          targetType ?? null,
          targetId ?? null,
          detail ? JSON.stringify(detail) : null,
          prevHash,
        ]
      );
      const row = ins.rows[0];
      const entryHash = computeEntryHash(prevHash, {
        id: row.id,
        orgId,
        userId: userId ?? null,
        action,
        targetType: targetType ?? null,
        targetId: targetId ?? null,
        detail: row.detail,
        createdAt: new Date(row.created_at).toISOString(),
      });
      await client.query("UPDATE audit_log SET entry_hash = $1 WHERE id = $2", [
        entryHash,
        row.id,
      ]);
    });
  } catch (err) {
    // Audit logging is a best-effort side-effect: a write failure must never
    // abort the operation being audited, so we swallow rather than rethrow.
    // But audit_log is a SOC 2 / GovRAMP forensic control — a silently missing
    // row is a compliance gap. Log enough context (org, action, target) that a
    // persistent failure is greppable and alertable instead of a faceless
    // "Audit log failed". Detail is omitted: it can carry user-supplied values.
    // Keep user-controlled values (action/target) out of the format-string
    // position — a value containing a printf token (e.g. "%s") would otherwise
    // capture the error arg. Constant format string, data passed as args.
    console.error(
      "Audit log failed for org=%s action=%s target=%s/%s:",
      orgId,
      action,
      targetType ?? "-",
      targetId ?? "-",
      err
    );
  }
}
