import pool, { tenantQuery, maintenanceQuery } from "./db.js";
import { getStorage, type Storage } from "./storage.js";
import { logAudit } from "./audit.js";

// `storage` is injectable so tests can drive the failure-isolation paths with a
// stub that throws; production callers (index.ts timer) pass nothing and get the
// real singleton.
export async function runRetentionCleanup(storage: Storage = getStorage()): Promise<void> {
  try {
    const orgs = await pool.query(
      "SELECT id, retention_days FROM organizations WHERE retention_days IS NOT NULL"
    );

    for (const org of orgs.rows) {
      // Isolate each org so one org's failure (a DB hiccup, a storage outage)
      // can't abort retention for every other org — or the invite/token prune
      // below. Without this, a single persistently-failing org would starve
      // every org iterated after it, on every nightly pass.
      try {
        await cleanupOrg(org, storage);
      } catch (err) {
        console.error(`Retention cleanup error for org ${org.id}:`, err);
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

// Prune one org's expired runs and their stored artifacts. Per-org error
// boundary: the DB DELETE commits per-statement (tenantQuery autocommit) before
// any storage call, so a storage failure is always after-the-fact — we log the
// orphan and press on; the S3 lifecycle rule is the documented backstop that
// sweeps it. Throwing here only aborts THIS org (the caller catches per-org).
async function cleanupOrg(
  org: { id: number; retention_days: number | string },
  storage: Storage
): Promise<void> {
  const days = Number(org.retention_days);
  if (!days || days <= 0) return;

  // `runs` has RLS; must run inside a tenant context so the
  // current_setting('app.current_org_id')::int cast in the policy has a
  // value to work with. Without it the cast blows up on an empty string.
  const runs = await tenantQuery(
    org.id,
    "DELETE FROM runs WHERE created_at < NOW() - ($1 * INTERVAL '1 day') RETURNING id",
    [days]
  );

  for (const run of runs.rows) {
    // A single artifact-delete failure must not abort the remaining runs (or
    // the audit row below): the DB row is already gone, so the worst case is an
    // orphaned object the S3 lifecycle backstop reaps. Log it and continue.
    try {
      await storage.deleteRun(run.id);
    } catch (err) {
      console.error(`Retention: failed to delete artifacts for run ${run.id} (org ${org.id}); leaving for S3 lifecycle backstop:`, err);
    }
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
