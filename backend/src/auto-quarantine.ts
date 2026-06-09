import pool from "./db.js";
import { tenantQuery } from "./db.js";
import { computeFlakyTests } from "./flaky-analysis.js";
import { logAudit } from "./audit.js";

// Deterministic auto-quarantine, run at run finalization. When an org opts in
// (auto_quarantine_enabled), any test that's flipped often enough over a wide
// enough run window is quarantined automatically with source='auto'. The intent
// is to fence off a known-flaky test from blocking PRs before a human gets to it.
//
// IMPORTANT: this NEVER clobbers an existing quarantine. The upsert is
// ON CONFLICT DO NOTHING, so a human's manual entry (or a prior auto entry)
// keeps its reason/owner — only brand-new flaky tests get an auto entry.

/**
 * Evaluate the org's auto-quarantine policy for a single suite and quarantine
 * any newly-qualifying flaky tests. Defensive: any failure is logged and
 * returns 0 rather than throwing into the caller (run finalization must never
 * break on this side-effect).
 *
 * @returns the number of tests newly auto-quarantined this call.
 */
export async function evaluateAutoQuarantine(orgId: number, suiteName: string): Promise<number> {
  try {
    // `organizations` has no RLS — see backend/src/routes/orgs.ts header.
    // orgId is always trusted; WHERE id = $1 is the tenant boundary.
    const policyRes = await pool.query(
      `SELECT auto_quarantine_enabled, auto_quarantine_min_flips, auto_quarantine_min_runs
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    const policy = policyRes.rows[0];
    if (!policy || !policy.auto_quarantine_enabled) return 0;

    const minFlips = policy.auto_quarantine_min_flips as number;
    const minRuns = policy.auto_quarantine_min_runs as number;

    // Widen the window to at least 30 runs so flip_count is measured over a
    // meaningful history even when the policy's min_runs is small.
    const flaky = await computeFlakyTests(orgId, {
      suite: suiteName,
      runWindow: Math.max(minRuns, 30),
    });

    let quarantined = 0;
    for (const test of flaky) {
      if (test.flip_count < minFlips || test.total_runs < minRuns) continue;

      const reason = `auto: ${test.flip_count} flips over ${test.total_runs} runs (rate ${test.flaky_rate}%)`;

      // ON CONFLICT DO NOTHING (not DO UPDATE): never overwrite an existing
      // manual or prior-auto entry. RETURNING id only yields a row when the
      // INSERT actually happened, so rowCount distinguishes new vs. conflict.
      const ins = await tenantQuery(orgId,
        `INSERT INTO quarantined_tests (org_id, full_title, file_path, suite_name, reason, quarantined_by, source)
         VALUES ($1, $2, $3, $4, $5, NULL, 'auto')
         ON CONFLICT (org_id, full_title, suite_name) DO NOTHING
         RETURNING id`,
        [orgId, test.full_title, test.file_path ?? "", suiteName, reason]
      );

      if (ins.rowCount && ins.rowCount > 0) {
        quarantined++;
        // logAudit's user-id arg is `number | null` (see audit.ts) — a
        // system-initiated quarantine has no acting user, so pass null.
        await logAudit(orgId, null, "quarantine.auto", "test", test.full_title, {
          suiteName,
          reason,
          flip_count: test.flip_count,
          total_runs: test.total_runs,
        });
      }
    }

    return quarantined;
  } catch (err) {
    console.error("evaluateAutoQuarantine failed for org=%s suite=%s:", orgId, suiteName, err);
    return 0;
  }
}
