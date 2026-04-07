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
    console.error("Audit log failed:", err);
  }
}
