/**
 * Specs/tests RLS WITH CHECK enforcement.
 *
 * Migration 039 adds explicit WITH CHECK clauses to specs_tenant_isolation
 * and tests_tenant_isolation. The original policies had USING only, which
 * relied on the runs policy's chain-join subquery to gate writes. A
 * future regression on the runs policy would silently let one org write
 * specs/tests under another org's runs.
 *
 * This test goes straight to the DB layer (connects as flakey_app, sets
 * app.current_org_id explicitly) and asserts that an INSERT into specs
 * referencing a foreign org's run is rejected by the WITH CHECK clause —
 * not by the USING-on-runs subquery.
 *
 * Skipped (with a clear message) if the connecting role can't talk to
 * the DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const DB = process.env.DB_NAME ?? "flakey";
const USER = process.env.DB_USER ?? "flakey_app";
const PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";

let pool: pg.Pool | null = null;
let canRun = false;
let orgA = 0;
let orgB = 0;
let runIdA = 0;
let specIdA = 0;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });
  try {
    await pool.query("SELECT 1");
    canRun = true;
  } catch (err) {
    console.warn(`[rls-with-check] could not connect, skipping: ${(err as Error).message}`);
    return;
  }

  // Seed two orgs + a run owned by org A. Use a transaction so cleanup
  // in `after` can roll the whole thing back.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Make org_id rows; we need to disable RLS on organizations momentarily?
    // No — `organizations` has no RLS in this schema, so direct inserts work.
    const a = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [`rls-test-A-${Date.now()}`, `rls-a-${Date.now()}`]
    );
    orgA = a.rows[0].id;
    const b = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [`rls-test-B-${Date.now()}`, `rls-b-${Date.now()}`]
    );
    orgB = b.rows[0].id;

    // Insert a run as org A.
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgA)]);
    const r = await client.query(
      `INSERT INTO runs (org_id, suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at)
       VALUES ($1, 'rls-test', 'main', 'abc', 'ci-1', 'mochawesome', NOW(), NOW())
       RETURNING id`,
      [orgA]
    );
    runIdA = r.rows[0].id;

    // Seed a legit spec under that run for the tests-table cross-org check.
    const s = await client.query(
      `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
       VALUES ($1, 'rls/spec.cy.ts', 'rls spec', 0, 0, 0, 0, 0)
       RETURNING id`,
      [runIdA]
    );
    specIdA = s.rows[0].id;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

after(async () => {
  if (!pool) return;
  if (canRun) {
    // organizations.id has FK references from runs.org_id (ON DELETE CASCADE
    // is not declared on every chain), so delete runs first under their
    // own org context. specs/tests cascade-delete from runs.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgA)]);
      await client.query("DELETE FROM runs WHERE org_id = $1", [orgA]);
      await client.query("COMMIT");
      // organizations has no RLS — delete outside the txn.
      await client.query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]);
    } finally {
      client.release();
    }
  }
  await pool.end();
});

test("specs INSERT is rejected when run_id belongs to another org (WITH CHECK fires)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    // Pose as org B and try to insert a spec under org A's run. Wrap
    // in BEGIN/COMMIT so `set_config(..., true)` applies for the
    // duration of the transaction (same shape as production
    // tenantQuery).
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgB)]);
    await assert.rejects(
      client.query(
        `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
         VALUES ($1, 'evil.cy.ts', 'should be blocked', 0, 0, 0, 0, 0)`,
        [runIdA]
      ),
      /row-level security/i,
      "spec INSERT under foreign run must be blocked by WITH CHECK"
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("tests INSERT is rejected when spec_id belongs to another org (WITH CHECK fires)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgB)]);
    await assert.rejects(
      client.query(
        `INSERT INTO tests (spec_id, full_title, status, duration_ms)
         VALUES ($1, 'evil', 'failed', 0)`,
        [specIdA]
      ),
      /row-level security/i,
      "test INSERT under foreign spec must be blocked by WITH CHECK"
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("specs INSERT is allowed when run_id belongs to the caller's org (USING/WITH CHECK match)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgA)]);
    const result = await client.query(
      `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
       VALUES ($1, 'allowed.cy.ts', 'allowed spec', 0, 0, 0, 0, 0)
       RETURNING id`,
      [runIdA]
    );
    assert.ok(result.rows[0]?.id, "in-org spec INSERT should succeed");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
