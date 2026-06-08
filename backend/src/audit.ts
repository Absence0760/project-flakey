import { tenantQuery } from "./db.js";

export async function logAudit(
  orgId: number,
  userId: number | null,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: object
): Promise<void> {
  try {
    await tenantQuery(orgId,
      `INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, userId, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    // Audit logging is a best-effort side-effect: a write failure must never
    // abort the operation being audited, so we swallow rather than rethrow.
    // But audit_log is a SOC 2 / GovRAMP forensic control — a silently missing
    // row is a compliance gap. Log enough context (org, action, target) that a
    // persistent failure is greppable and alertable instead of a faceless
    // "Audit log failed". Detail is omitted: it can carry user-supplied values.
    console.error(
      `Audit log failed for org=${orgId} action=${action} target=${targetType ?? "-"}/${targetId ?? "-"}:`,
      err
    );
  }
}
