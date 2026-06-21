import pool, { tenantQuery, maintenanceQuery } from "./db.js";
import { getStorage, type Storage } from "./storage.js";
import { logAudit } from "./audit.js";
import { isAutocloseEligible, AUTOCLOSE_ELIGIBLE_STATUSES } from "./error-automation.js";
import { dispatchErrorGroupEvent } from "./webhooks.js";
import { syncErrorGroupTransition } from "./integrations/jira.js";

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
    // Pull both per-org nightly settings together: retention_days drives the
    // run/artifact prune; triage_autoclose_days drives the auto-close-on-green
    // sweep (Phase 15.2 (b)). An org qualifies if EITHER is set — a org that
    // opted into autoclose but not retention must still get swept.
    const orgs = await pool.query(
      `SELECT id, retention_days, triage_autoclose_days
         FROM organizations
        WHERE retention_days IS NOT NULL
           OR triage_autoclose_days IS NOT NULL`
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
      // Auto-close sweep gets its OWN per-org error boundary: a failure here
      // (a malformed setting, a transient DB error) must not skip the run/
      // artifact prune above for the NEXT org, nor the global prunes below.
      try {
        await autocloseStaleErrorGroups(org);
      } catch (err) {
        console.error(`Auto-close sweep error for org ${org.id}:`, err);
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
  org: { id: number; retention_days: number | string | null },
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

// Phase 15.2 (b) — auto-close-on-green. For an org that opted into
// triage_autoclose_days, transition every open/investigating/regressed error
// group whose fingerprint has not reappeared for the configured window to
// `fixed`, write an audit row, and emit error.autoclosed. Default OFF: a NULL
// (or non-positive) setting skips the org entirely — silently flipping triage
// state is opt-in only.
//
// "last_seen" for a group is derived from the run data (error_groups has no
// last_seen column): MAX(r.created_at) over the failing tests that match its
// fingerprint. We compute it per candidate group and feed the pure
// isAutocloseEligible predicate so the window math is unit-tested in isolation.
async function autocloseStaleErrorGroups(
  org: { id: number; triage_autoclose_days: number | string | null }
): Promise<void> {
  const days = Number(org.triage_autoclose_days);
  // Default OFF: NULL / 0 / negative / NaN → skip the org entirely.
  if (!org.triage_autoclose_days || !Number.isFinite(days) || days <= 0) return;

  // Candidate groups: eligible status only, with their derived last_seen from
  // the run stream. RLS-scoped via tenantQuery. A group whose fingerprint has
  // no matching failing test yields last_seen NULL — the predicate never closes
  // those (we close only on positive evidence of green, not absence of data).
  const candidates = await tenantQuery(
    org.id,
    `SELECT eg.fingerprint,
            eg.status,
            agg.last_seen,
            agg.suite_name,
            agg.error_message
       FROM error_groups eg
       LEFT JOIN LATERAL (
         SELECT MAX(r.created_at) AS last_seen,
                MAX(r.suite_name)  AS suite_name,
                MAX(t.error_message) AS error_message
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs r ON r.id = s.run_id
         WHERE t.status = 'failed'
           AND t.error_message IS NOT NULL
           AND md5(t.error_message || '|' || r.suite_name) = eg.fingerprint
       ) agg ON TRUE
      WHERE eg.org_id = $1
        AND eg.status = ANY($2::text[])`,
    [org.id, AUTOCLOSE_ELIGIBLE_STATUSES as readonly string[]]
  );

  const now = new Date();
  const toClose = candidates.rows.filter((row) =>
    isAutocloseEligible({
      status: row.status,
      lastSeen: row.last_seen,
      autocloseDays: days,
      now,
    })
  );
  if (toClose.length === 0) return;

  for (const row of toClose) {
    // Transition to fixed under the same org context. Re-check the eligible
    // status in the WHERE so a concurrent manual edit (e.g. a human moved it to
    // `known`) isn't clobbered between our read and write.
    const upd = await tenantQuery(
      org.id,
      `UPDATE error_groups
          SET status = 'fixed', updated_at = NOW()
        WHERE org_id = $1
          AND fingerprint = $2
          AND status = ANY($3::text[])
        RETURNING fingerprint`,
      [org.id, row.fingerprint, AUTOCLOSE_ELIGIBLE_STATUSES as readonly string[]]
    );
    if (upd.rows.length === 0) continue; // lost the race; skip audit + webhook.

    // Audit every transition (system-initiated → userId null = "System").
    await logAudit(
      org.id,
      null,
      "error.autoclosed",
      "error_group",
      row.fingerprint,
      { previous_status: row.status, autoclose_days: days, last_seen: row.last_seen }
    );

    // Notify. Best-effort (swallows internally) — a webhook failure must not
    // abort the rest of the sweep.
    await dispatchErrorGroupEvent(org.id, "error.autoclosed", {
      fingerprint: row.fingerprint,
      suite_name: row.suite_name ?? "",
      status: "fixed",
      error_message: row.error_message ?? null,
    });

    // Phase 15.4 outbound sync (additive — keep localized; sibling 15.3 also
    // edits this file). Reflect the auto-close onto the linked Jira issue.
    // Best-effort: swallows + returns null on any Jira error so a failure can't
    // abort the rest of the sweep. Audited only when Jira actually moved.
    const syncedKey = await syncErrorGroupTransition(
      org.id,
      row.fingerprint,
      "fixed",
      `test green for ${days} day(s) — auto-resolving.`
    );
    if (syncedKey) {
      await logAudit(org.id, null, "jira.issue.transition", "error_group", row.fingerprint, {
        issue_key: syncedKey,
        direction: "fixed",
        trigger: "autoclose",
        autoclose_days: days,
      });
    }
  }

  console.log(`Auto-close: closed ${toClose.length} stale error group(s) for org ${org.id} (window ${days}d)`);
}
