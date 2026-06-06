import pool, { tenantQuery, maintenanceQuery } from "./db.js";
import { getStorage } from "./storage.js";
import { logAudit } from "./audit.js";

export async function runRetentionCleanup(): Promise<void> {
  try {
    const storage = getStorage();
    const orgs = await pool.query(
      "SELECT id, retention_days FROM organizations WHERE retention_days IS NOT NULL"
    );

    for (const org of orgs.rows) {
      const days = Number(org.retention_days);
      if (!days || days <= 0) continue;

      // `runs` has RLS; must run inside a tenant context so the
      // current_setting('app.current_org_id')::int cast in the policy has a
      // value to work with. Without it the cast blows up on an empty string.
      const runs = await tenantQuery(
        org.id,
        "DELETE FROM runs WHERE created_at < NOW() - ($1 * INTERVAL '1 day') RETURNING id",
        [days]
      );

      for (const run of runs.rows) {
        await storage.deleteRun(run.id);
      }

      if (runs.rows.length > 0) {
        console.log(`Retention: deleted ${runs.rows.length} run(s) older than ${org.retention_days}d for org ${org.id}`);
        // System-initiated cleanup has no acting user: pass userId null so the
        // FK stays valid and the UI renders it as "System". logAudit is scoped
        // to this org so its tenantQuery satisfies the audit_log RLS policy.
        await logAudit(
          org.id,
          null,
          "retention.cleanup",
          "run",
          "",
          { deleted_count: runs.rows.length, retention_days: org.retention_days }
        );
      }
    }
    // Clean up expired org invites
    const invites = await pool.query(
      "DELETE FROM org_invites WHERE expires_at < NOW()"
    );
    if (invites.rowCount && invites.rowCount > 0) {
      console.log(`Retention: deleted ${invites.rowCount} expired invite(s)`);
    }

    // Prune long-dead refresh-token revocation rows. A revoked jti is only
    // useful until the token's own exp passes (max 7d), so rows older than
    // 14 days can never gate a replay. The table is FORCE-RLS user-scoped, so
    // this system-level prune runs via maintenanceQuery (app.maintenance='on'),
    // which the migration-052 DELETE policy admits. Bounds table growth
    // (the TODO from migration 037).
    const revoked = await maintenanceQuery(
      "DELETE FROM revoked_refresh_tokens WHERE revoked_at < NOW() - INTERVAL '14 days'"
    );
    if (revoked.rowCount && revoked.rowCount > 0) {
      console.log(`Retention: pruned ${revoked.rowCount} expired revoked-refresh-token row(s)`);
    }
  } catch (err) {
    console.error("Retention cleanup error:", err);
  }
}
