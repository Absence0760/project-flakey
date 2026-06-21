// Phase 15.2 (a) — ingest-time recurrence detection → auto-reopen.
//
// "A failure we declared fixed coming back is the single highest-signal triage
// event, and today it's invisible." On every upload, after a run's failing
// tests are recorded, we check whether any of this run's failing fingerprints
// already has an error_groups row in status `fixed`. Each such fingerprint is
// transitioned `fixed → regressed`, its recurrence_count bumped, and
// last_recurred_at stamped. The caller fires an `error.regressed` webhook for
// each returned fingerprint AFTER the transaction commits.
//
// This is the ONE ingest-time recurrence path — both upload routes (POST /runs
// and POST /runs/upload) call recordErrorRecurrence from inside their existing
// tenant-scoped transaction. Don't add a second path (guard rail / backend
// CLAUDE.md). The fingerprint formula md5(error_message || '|' || suite_name)
// is the same one GET /errors, analyze.ts and seed.ts use — kept in lockstep.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { NormalizedRun } from "./types.js";
import { dispatchErrorGroupEvent } from "./webhooks.js";
import { syncErrorGroupTransition } from "./integrations/jira.js";
import { logAudit } from "./audit.js";

/** md5(error_message || '|' || suite_name) — the stable error-group identity. */
export function computeFingerprint(errorMessage: string, suiteName: string): string {
  return createHash("md5").update(`${errorMessage}|${suiteName}`).digest("hex");
}

/**
 * The distinct fingerprints of a run's FAILING tests that carry an error
 * message — exactly the rows GET /errors would aggregate for this suite. A
 * failing test with no error_message produces no fingerprint (md5 of a null
 * concatenation), so we skip it, matching the `error_message IS NOT NULL`
 * guard in the /errors aggregate.
 */
export function failingFingerprints(run: NormalizedRun): string[] {
  const suite = run.meta.suite_name;
  const seen = new Set<string>();
  for (const spec of run.specs) {
    for (const t of spec.tests) {
      if (t.status !== "failed") continue;
      const msg = t.error?.message;
      if (!msg) continue;
      seen.add(computeFingerprint(msg, suite));
    }
  }
  return [...seen];
}

/**
 * Transition any `fixed` error groups whose fingerprint reappears in this run
 * to `regressed`, bumping recurrence_count and stamping last_recurred_at.
 *
 * Runs on the caller's ORG-SCOPED transaction client (app.current_org_id is
 * already set by tenantTransaction), so the UPDATE is RLS-enforced — it can
 * only ever touch this org's rows. Returns the fingerprints that actually
 * transitioned (status WAS 'fixed'); the caller emits one error.regressed
 * webhook per returned fingerprint. An empty run (no failing fingerprints, or
 * none currently `fixed`) returns [] and writes nothing.
 *
 * Idempotent within a run: the `WHERE status = 'fixed'` guard means a second
 * upload of the same already-regressed run won't re-bump the counter — only the
 * fixed→regressed edge counts as a recurrence.
 */
export async function recordErrorRecurrence(
  client: PoolClient,
  orgId: number,
  run: NormalizedRun
): Promise<string[]> {
  const fingerprints = failingFingerprints(run);
  if (fingerprints.length === 0) return [];

  const result = await client.query(
    `UPDATE error_groups
        SET status = 'regressed',
            recurrence_count = recurrence_count + 1,
            last_recurred_at = NOW(),
            updated_at = NOW()
      WHERE org_id = $1
        AND fingerprint = ANY($2::text[])
        AND status = 'fixed'
      RETURNING fingerprint`,
    [orgId, fingerprints]
  );

  return result.rows.map((r) => r.fingerprint as string);
}

/**
 * Build a fingerprint → first-seen error message map from a run's failing
 * tests, so a regressed fingerprint can carry its message in the webhook.
 */
function messageByFingerprint(run: NormalizedRun): Map<string, string> {
  const suite = run.meta.suite_name;
  const map = new Map<string, string>();
  for (const spec of run.specs) {
    for (const t of spec.tests) {
      if (t.status !== "failed") continue;
      const msg = t.error?.message;
      if (!msg) continue;
      const fp = computeFingerprint(msg, suite);
      if (!map.has(fp)) map.set(fp, msg);
    }
  }
  return map;
}

/**
 * Fire one error.regressed webhook per fingerprint that reopened on this
 * ingest. Best-effort + fire-and-forget (dispatchErrorGroupEvent swallows
 * internally), called AFTER the ingest transaction commits so the regressed
 * row is durable before we notify. Shared by both upload routes so there's a
 * single notification path.
 */
export function dispatchRegressionWebhooks(
  orgId: number,
  run: NormalizedRun,
  regressedFingerprints: string[]
): void {
  if (regressedFingerprints.length === 0) return;
  const messages = messageByFingerprint(run);
  for (const fp of regressedFingerprints) {
    void dispatchErrorGroupEvent(orgId, "error.regressed", {
      fingerprint: fp,
      suite_name: run.meta.suite_name,
      status: "regressed",
      error_message: messages.get(fp) ?? null,
    });
  }
}

/**
 * Phase 15.4 outbound sync — reflect each ingest-time → regressed transition
 * onto its linked Jira issue (reopen + comment). Jira has no run data, so this
 * auto-reopen is the demo-able "wow." Best-effort + fire-and-forget, called
 * AFTER the ingest transaction commits (alongside dispatchRegressionWebhooks)
 * so the regressed row is durable first. syncErrorGroupTransition swallows all
 * Jira errors internally and returns null on failure, so a Jira outage can
 * never break ingest. Audits `jira.issue.transition` only when Jira moved.
 */
export function syncRegressionsToJira(
  orgId: number,
  run: NormalizedRun,
  regressedFingerprints: string[]
): void {
  if (regressedFingerprints.length === 0) return;
  void (async () => {
    for (const fp of regressedFingerprints) {
      const issueKey = await syncErrorGroupTransition(
        orgId,
        fp,
        "regressed",
        "this test regressed — a previously-fixed failure is back. Reopening."
      );
      if (issueKey) {
        await logAudit(orgId, null, "jira.issue.transition", "error_group", fp, {
          issue_key: issueKey,
          direction: "regressed",
          trigger: "ingest",
          suite_name: run.meta.suite_name,
        });
      }
    }
  })();
}
