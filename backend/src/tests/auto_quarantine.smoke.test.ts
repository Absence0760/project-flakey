/**
 * Auto-quarantine smoke tests (Feature A — backend/src/auto-quarantine.ts).
 *
 * evaluateAutoQuarantine(orgId, suite) runs at run finalization. When an org
 * opts in (auto_quarantine_enabled) it quarantines any test that's flipped
 * often enough (auto_quarantine_min_flips) over a wide enough run window
 * (auto_quarantine_min_runs) with source='auto'. The two load-bearing
 * invariants this file pins:
 *
 *   1. A qualifying flaky test gets a quarantined_tests row with source='auto'
 *      — but ONLY when the org has opted in. A disabled org quarantines nothing.
 *   2. The upsert is ON CONFLICT DO NOTHING, so a pre-existing MANUAL entry for
 *      a different test is never clobbered — its source stays 'manual'.
 *
 * Runs in-process against the local DB (pnpm db:up + a migrated schema). Each
 * test provisions its OWN org and suite, so assertions never depend on seed
 * data or collide with other agents sharing the DB. The DB user defaults to
 * the non-superuser flakey_app so RLS applies — tenant writes go through
 * tenantQuery, never bare pool (organizations is the one no-RLS table, written
 * by id like the routes do).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pool, { tenantQuery, tenantTransaction } from "../db.js";
import { evaluateAutoQuarantine } from "../auto-quarantine.js";

after(async () => {
  // Release the pool so `node --test` exits instead of hanging on open handles.
  await pool.end();
});

/** Create a fresh org row directly (organizations has no RLS) and return its id. */
async function createOrg(label: string, policy: {
  enabled: boolean;
  minFlips: number;
  minRuns: number;
}): Promise<number> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await pool.query(
    `INSERT INTO organizations (name, slug, auto_quarantine_enabled, auto_quarantine_min_flips, auto_quarantine_min_runs)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [`${label}-${stamp}`, `${label}-${stamp}`, policy.enabled, policy.minFlips, policy.minRuns]
  );
  return res.rows[0].id as number;
}

/**
 * Upload one run of a suite directly to the DB (runs → specs → tests), scoped
 * to the org via RLS. Awaited fully so created_at advances strictly before the
 * next run, keeping the flaky timeline order deterministic.
 */
async function insertRun(
  orgId: number,
  suite: string,
  tests: Array<{ full_title: string; status: "passed" | "failed" }>,
): Promise<void> {
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Insert run → spec → tests as separate statements in one tenant-scoped
  // transaction. They can't be a single multi-CTE INSERT: the specs RLS
  // WITH CHECK runs `run_id IN (SELECT id FROM runs)`, and a sibling
  // data-modifying CTE's new run row isn't visible to that subquery — the
  // spec insert would fail the row-level security check.
  await tenantTransaction(orgId, async (client) => {
    const runRes = await client.query(
      `INSERT INTO runs (org_id, suite_name, branch, commit_sha, ci_run_id, reporter, total, passed, failed, finished_at)
       VALUES ($1, $2, 'main', $3, $4, 'mochawesome', $5, $6, $7, now())
       RETURNING id`,
      [orgId, suite, stamp, `ci-${stamp}`, tests.length, passed, failed]
    );
    const runId = runRes.rows[0].id as number;
    const specRes = await client.query(
      `INSERT INTO specs (run_id, file_path, title, total, passed, failed)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [runId, `${suite}.cy.ts`, suite, tests.length, passed, failed]
    );
    const specId = specRes.rows[0].id as number;
    for (const t of tests) {
      await client.query(
        `INSERT INTO tests (spec_id, title, full_title, status, error_message)
         VALUES ($1, $2, $2, $3, $4)`,
        [specId, t.full_title, t.status, t.status === "failed" ? "AssertionError: boom" : null]
      );
    }
  });
}

/** Seed a clearly-flaky history (alternating fail/pass) for one test over N runs. */
async function seedFlakyHistory(orgId: number, suite: string, fullTitle: string, runCount: number): Promise<void> {
  for (let i = 0; i < runCount; i++) {
    await insertRun(orgId, suite, [
      { full_title: fullTitle, status: i % 2 === 0 ? "failed" : "passed" },
    ]);
  }
}

async function quarantineRows(orgId: number, suite: string): Promise<Array<{ full_title: string; source: string; reason: string | null }>> {
  const res = await tenantQuery(orgId,
    "SELECT full_title, source, reason FROM quarantined_tests WHERE suite_name = $1 ORDER BY full_title",
    [suite]
  );
  return res.rows as Array<{ full_title: string; source: string; reason: string | null }>;
}

// ── 1. Disabled org quarantines nothing ──────────────────────────────────

test("disabled org: evaluateAutoQuarantine quarantines nothing even with a flaky history", async () => {
  const orgId = await createOrg("aq-off", { enabled: false, minFlips: 2, minRuns: 4 });
  const suite = `aq-off-suite-${Date.now()}`;
  const flaky = "Checkout > flaky charge";
  // A history that would easily qualify if the policy were on.
  await seedFlakyHistory(orgId, suite, flaky, 10);

  const count = await evaluateAutoQuarantine(orgId, suite);
  assert.equal(count, 0, "a disabled org must auto-quarantine nothing");
  assert.equal((await quarantineRows(orgId, suite)).length, 0, "no quarantined_tests row should exist");
});

// ── 2. Enabled org auto-quarantines a qualifying flaky test ───────────────

test("enabled org: a qualifying flaky test gets a source='auto' quarantine row", async () => {
  // Low policy so a modest history qualifies: 2 flips over 4 runs.
  const orgId = await createOrg("aq-on", { enabled: true, minFlips: 2, minRuns: 4 });
  const suite = `aq-on-suite-${Date.now()}`;
  const flaky = "Payments > flaky settlement";
  // 6 alternating runs → flip_count = 5, total_runs = 6: clears both thresholds.
  await seedFlakyHistory(orgId, suite, flaky, 6);

  const count = await evaluateAutoQuarantine(orgId, suite);
  assert.equal(count, 1, "exactly the one qualifying flaky test is auto-quarantined");

  const rows = await quarantineRows(orgId, suite);
  const row = rows.find((r) => r.full_title === flaky);
  assert.ok(row, "the flaky test must have a quarantined_tests row");
  assert.equal(row.source, "auto", "the auto entry must carry source='auto'");
  assert.match(row.reason ?? "", /^auto:/, "the auto entry's reason names it as auto-generated");
});

// ── 2b. A non-qualifying (stable) test is NOT quarantined ─────────────────

test("enabled org: a test below the flip/run thresholds is not quarantined", async () => {
  const orgId = await createOrg("aq-stable", { enabled: true, minFlips: 4, minRuns: 10 });
  const suite = `aq-stable-suite-${Date.now()}`;
  const flaky = "Login > occasionally slow";
  // Only 4 runs total — below min_runs=10, so it must not qualify even though
  // it flips. (Guards against the threshold being ignored.)
  await seedFlakyHistory(orgId, suite, flaky, 4);

  const count = await evaluateAutoQuarantine(orgId, suite);
  assert.equal(count, 0, "a test below min_runs must not be auto-quarantined");
});

// ── 3. A pre-existing MANUAL quarantine is never clobbered ────────────────

test("enabled org: an existing manual quarantine for another test keeps source='manual'", async () => {
  const orgId = await createOrg("aq-manual", { enabled: true, minFlips: 2, minRuns: 4 });
  const suite = `aq-manual-suite-${Date.now()}`;
  const manualTest = "Profile > manually quarantined";
  const autoTest = "Search > flaky results";

  // A human manually quarantines one test up front (source defaults to 'manual').
  await tenantQuery(orgId,
    `INSERT INTO quarantined_tests (org_id, full_title, file_path, suite_name, reason, quarantined_by, source)
     VALUES ($1, $2, $3, $4, $5, NULL, 'manual')`,
    [orgId, manualTest, "profile.cy.ts", suite, "human: investigating in FLAKEY-99"]
  );

  // A different test has a clearly-flaky history and should be auto-quarantined.
  await seedFlakyHistory(orgId, suite, autoTest, 6);

  const count = await evaluateAutoQuarantine(orgId, suite);
  assert.equal(count, 1, "only the newly-flaky test is auto-quarantined this call");

  const rows = await quarantineRows(orgId, suite);
  const manual = rows.find((r) => r.full_title === manualTest);
  const auto = rows.find((r) => r.full_title === autoTest);

  assert.ok(manual, "the manual entry must still exist");
  assert.equal(manual.source, "manual", "the manual entry's source must NOT be flipped to 'auto'");
  assert.equal(
    manual.reason,
    "human: investigating in FLAKEY-99",
    "the manual entry's reason must be untouched (ON CONFLICT DO NOTHING)",
  );

  assert.ok(auto, "the flaky test must be auto-quarantined alongside the manual one");
  assert.equal(auto.source, "auto", "the new entry must carry source='auto'");
});

// ── 3b. ON CONFLICT DO NOTHING preserves a manual entry for the SAME test ──

test("enabled org: a manual quarantine on a flaky test is preserved, not overwritten by auto", async () => {
  // The clearest statement of the no-clobber property: the very test that WOULD
  // auto-qualify is already manually quarantined. The auto pass must leave the
  // manual row's source/reason intact and report 0 new quarantines.
  const orgId = await createOrg("aq-sametest", { enabled: true, minFlips: 2, minRuns: 4 });
  const suite = `aq-sametest-suite-${Date.now()}`;
  const both = "Reports > flaky export";

  await seedFlakyHistory(orgId, suite, both, 6);
  await tenantQuery(orgId,
    `INSERT INTO quarantined_tests (org_id, full_title, file_path, suite_name, reason, quarantined_by, source)
     VALUES ($1, $2, $3, $4, $5, NULL, 'manual')`,
    [orgId, both, "reports.cy.ts", suite, "human: known flaky, owner assigned"]
  );

  const count = await evaluateAutoQuarantine(orgId, suite);
  assert.equal(count, 0, "the auto pass must report 0 — the row already exists (ON CONFLICT DO NOTHING)");

  const rows = await quarantineRows(orgId, suite);
  assert.equal(rows.length, 1, "still exactly one row for the test");
  assert.equal(rows[0].source, "manual", "the manual source must survive the auto pass");
  assert.equal(rows[0].reason, "human: known flaky, owner assigned", "the manual reason must survive");
});
