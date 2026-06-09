import pool, { tenantQuery, maintenanceQuery } from "./db.js";
import { getStorage, type Storage } from "./storage.js";
import { logAudit } from "./audit.js";

// Delete expired org invites; returns how many rows went. Plain pool.query:
// org_invites carries no RLS, so no tenant context is needed.
export async function pruneExpiredInvites(): Promise<number> {
  const r = await pool.query("DELETE FROM org_invites WHERE expires_at < NOW()");
  return r.rowCount ?? 0;
}

// Prune long-dead refresh-token revocation rows. A revoked jti is only useful
// until the token's own exp passes (max 7d), so rows older than 14 days can
// never gate a replay. The table is FORCE-RLS user-scoped, so this system-level
// prune runs via maintenanceQuery (app.maintenance='on'), which the
// migration-052 DELETE policy admits. Bounds table growth (the TODO from
// migration 037). Returns how many rows went.
export async function pruneRevokedRefreshTokens(): Promise<number> {
  const r = await maintenanceQuery(
    "DELETE FROM revoked_refresh_tokens WHERE revoked_at < NOW() - INTERVAL '14 days'"
  );
  return r.rowCount ?? 0;
}

// `storage` and the two prune steps are injectable so tests can drive the
// failure-isolation paths with stubs that throw; production callers (the
// index.ts timer) pass nothing and get the real singleton + DB-backed prunes.
export interface RetentionDeps {
  pruneInvites?: () => Promise<number>;
  pruneRevokedTokens?: () => Promise<number>;
}

export async function runRetentionCleanup(
  storage: Storage = getStorage(),
  deps: RetentionDeps = {}
): Promise<void> {
  const pruneInvites = deps.pruneInvites ?? pruneExpiredInvites;
  const pruneRevokedTokens = deps.pruneRevokedTokens ?? pruneRevokedRefreshTokens;
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

    // The two global prunes are unrelated maintenance tasks, so each gets its
    // own error boundary: a failure in one (a lock timeout, a transient DB
    // error) must not skip the other. They previously shared one try block — a
    // throw in the invite prune fell through to the outer catch and silently
    // skipped the token prune for the whole night. This extends the same
    // per-org isolation discipline above to the global prunes.
    try {
      const n = await pruneInvites();
      if (n > 0) console.log(`Retention: deleted ${n} expired invite(s)`);
    } catch (err) {
      console.error("Retention: expired-invite prune failed:", err);
    }

    try {
      const n = await pruneRevokedTokens();
      if (n > 0) console.log(`Retention: pruned ${n} expired revoked-refresh-token row(s)`);
    } catch (err) {
      console.error("Retention: revoked-refresh-token prune failed:", err);
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
