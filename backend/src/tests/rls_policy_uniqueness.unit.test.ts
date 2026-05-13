/**
 * Asserts that the four tables normalised in migrations 042 + 043
 * (saved_views, ai_analyses, quarantined_tests, live_events) have
 * exactly ONE tenant policy each, not two.
 *
 * Background: migration 042 created `*_tenant` policies but did not
 * drop the older `*_org_isolation` policies from 016/017/018. Under
 * PERMISSIVE-mode RLS, "either policy passes" semantics mean both
 * orphan and replacement were live simultaneously. They had identical
 * predicates (just different casts) so no row leaked, but the dual
 * policy state made future audit/edit dangerous. Migration 043 drops
 * the orphans. This test pins that drop.
 *
 * If a future migration re-introduces a second policy on one of these
 * tables (whether by accident or by design) this test fails, forcing
 * an explicit decision rather than silent drift.
 *
 * Skipped if the DB is unreachable (mirrors the other RLS unit tests).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const DB = process.env.DB_NAME ?? "flakey";
const USER = process.env.DB_USER ?? "flakey_app";
const PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";

const NORMALISED_TABLES = [
  "saved_views",
  "ai_analyses",
  "quarantined_tests",
  "live_events",
] as const;

let pool: pg.Pool | null = null;
let canRun = false;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });
  try {
    await pool.query("SELECT 1");
    canRun = true;
  } catch (err) {
    console.warn(`[rls-policy-uniqueness] could not connect, skipping: ${(err as Error).message}`);
  }
});

after(async () => {
  await pool?.end();
});

for (const table of NORMALISED_TABLES) {
  test(`${table} has exactly one PERMISSIVE policy after migration 043 (orphaned *_org_isolation gone)`, async () => {
    if (!canRun) return;
    const res = await pool!.query<{ policyname: string; permissive: string }>(
      `SELECT policyname, permissive
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1
        ORDER BY policyname`,
      [table],
    );
    // Filter to the permissive-mode policies; any restrictive policies
    // are layered on top and don't count toward the "one tenant policy
    // per table" invariant.
    const permissive = res.rows.filter((r) => r.permissive === "PERMISSIVE");
    assert.equal(
      permissive.length,
      1,
      `expected exactly one PERMISSIVE policy on ${table}, got ${permissive.length}: ${permissive.map((p) => p.policyname).join(", ")}`,
    );
    assert.equal(
      permissive[0].policyname,
      `${table}_tenant`,
      `the surviving policy on ${table} must be the canonical *_tenant form, not the legacy *_org_isolation`,
    );
  });
}

test("no other RLS-protected tenant table has a leftover *_org_isolation policy", async () => {
  if (!canRun) return;
  // Catch-all sweep so a future migration that adds the wrong-shaped
  // policy on a new table also trips this test.
  const res = await pool!.query<{ tablename: string; policyname: string }>(
    `SELECT tablename, policyname
       FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname LIKE '%_org_isolation'
      ORDER BY tablename, policyname`,
  );
  assert.equal(
    res.rowCount,
    0,
    `legacy *_org_isolation policies still present: ${res.rows.map((r) => `${r.tablename}.${r.policyname}`).join(", ")}`,
  );
});
