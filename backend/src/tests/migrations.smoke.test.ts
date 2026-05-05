/**
 * Migration apply-from-empty smoke test.
 *
 * Catches the worst class of deploy-time bug: a migration that works on
 * the dev DB (which already has the prior state) but fails on a fresh
 * install — e.g., an ALTER TABLE that adds NOT NULL without a default
 * and silently assumes existing rows, or a migration that references
 * tables that haven't been created yet because filename ordering and
 * dependency ordering disagree.
 *
 * What this test does:
 *   1. Connects as the `flakey` superuser (POSTGRES_USER, has CREATEDB).
 *   2. CREATEs a one-off database with a unique name.
 *   3. Runs every migration in lexical order against the empty DB.
 *   4. Asserts the expected core tables and a sample of indexes exist.
 *   5. DROPs the database.
 *
 * Skipped (with a clear message) if the connecting role lacks CREATEDB —
 * smoke runs in CI typically connect as the superuser, but local-dev
 * setups using flakey_app would skip rather than fail noisily.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const SUPER_USER = process.env.DB_SUPERUSER ?? "flakey";
const SUPER_PASSWORD = process.env.DB_SUPERUSER_PASSWORD ?? "flakey";
const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const SOURCE_DB = process.env.DB_NAME ?? "flakey";

const TEST_DB = `flakey_mig_test_${Date.now()}`;
const MIGRATIONS_DIR = join(process.cwd(), "migrations");

let testClient: pg.Client | null = null;
let canRun = false;

before(async () => {
  // Step 1: connect to the existing DB to issue CREATE DATABASE.
  const admin = new pg.Client({
    host: HOST, port: PORT, user: SUPER_USER, password: SUPER_PASSWORD, database: SOURCE_DB,
  });
  try {
    await admin.connect();
  } catch (err) {
    console.warn(`[migrations test] could not connect as ${SUPER_USER}, skipping: ${(err as Error).message}`);
    return;
  }

  const roleCheck = await admin.query(
    "SELECT rolcreatedb FROM pg_roles WHERE rolname = $1",
    [SUPER_USER]
  );
  if (!roleCheck.rows[0]?.rolcreatedb) {
    console.warn(`[migrations test] role ${SUPER_USER} lacks CREATEDB, skipping`);
    await admin.end();
    return;
  }

  // CREATE DATABASE doesn't accept parameters via $1 — concatenate after
  // sanitizing.  TEST_DB is built from Date.now(), which is purely
  // numeric, so this is safe; still validate to fail loud if someone
  // changes the format later.
  if (!/^[a-z0-9_]+$/.test(TEST_DB)) {
    throw new Error(`unsafe TEST_DB name: ${TEST_DB}`);
  }
  await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  await admin.end();

  // Step 2: connect to the fresh DB and grant flakey_app role what
  // production migrations expect to be granted to.
  testClient = new pg.Client({
    host: HOST, port: PORT, user: SUPER_USER, password: SUPER_PASSWORD, database: TEST_DB,
  });
  await testClient.connect();
  // Some migrations grant to flakey_app — make sure that role exists in
  // the fresh DB (roles are cluster-scoped so this is usually a no-op).
  await testClient.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flakey_app') THEN
      CREATE ROLE flakey_app LOGIN;
    END IF;
  END $$`);

  canRun = true;
});

after(async () => {
  if (!testClient) return;
  await testClient.end().catch(() => {});

  // Drop the test DB. Need a fresh admin connection because we can't
  // drop the DB we're connected to.
  const admin = new pg.Client({
    host: HOST, port: PORT, user: SUPER_USER, password: SUPER_PASSWORD, database: SOURCE_DB,
  });
  try {
    await admin.connect();
    // Force-disconnect any stragglers, then drop.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DB]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  } catch (err) {
    console.warn(`[migrations test] cleanup of ${TEST_DB} failed: ${(err as Error).message}`);
  } finally {
    await admin.end().catch(() => {});
  }
});

// ── Filename ordering invariants ────────────────────────────────────────

test("migrations: filenames are sequentially numbered with no gaps or duplicates", () => {
  // Catches the "two PRs both used 037_foo.sql, last-merge-wins
  // overwrote the other" class of mistake.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const numbers = files.map((f) => {
    const m = f.match(/^(\d+)_/);
    if (!m) throw new Error(`migration ${f} doesn't start with NNN_`);
    return Number(m[1]);
  });
  for (let i = 1; i < numbers.length; i++) {
    assert.ok(numbers[i] > numbers[i - 1],
      `migration ordering broken: ${files[i - 1]} (${numbers[i - 1]}) → ${files[i]} (${numbers[i]})`);
    assert.notEqual(numbers[i], numbers[i - 1],
      `duplicate migration number: ${files[i]} and ${files[i - 1]}`);
  }
});

test("migrations: every file is non-empty SQL", () => {
  // Cheap sanity check — empty migration files fail silently in psql but
  // confuse anyone trying to track schema history.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), "utf-8").trim();
    assert.ok(content.length > 0, `${f} is empty`);
  }
});

// ── Apply-from-empty (the real test) ────────────────────────────────────

// CREATE INDEX CONCURRENTLY can't run inside a transaction block, and
// pg's simple-query protocol bundles multi-statement scripts into one
// implicit transaction. Files that contain CONCURRENTLY are split into
// individual statements and executed one at a time so each gets its
// own implicit transaction. Splitting is naive (semicolons), which is
// fine for the constrained subset of SQL used in these migrations
// (no $$ blocks in CONCURRENTLY-using files).
async function applyMigration(client: pg.Client, sql: string, file: string): Promise<void> {
  const needsSplit = /create\s+index\s+concurrently/i.test(sql);
  if (!needsSplit) {
    await client.query(sql);
    return;
  }
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await client.query(stmt);
    } catch (err) {
      throw new Error(`statement in ${file} failed: ${(err as Error).message}\nstatement: ${stmt.slice(0, 200)}`);
    }
  }
}

test("migrations: every migration applies cleanly to a fresh database", async () => {
  if (!canRun || !testClient) {
    console.warn("[migrations test] skipped — see before() warning");
    return;
  }
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
    try {
      await applyMigration(testClient, sql, f);
    } catch (err) {
      // Make the failure self-describing — operators reading CI logs need
      // to know which migration broke and why.
      throw new Error(`migration ${f} failed on fresh DB: ${(err as Error).message}`);
    }
  }
});

test("migrations: core tables exist after applying all migrations to a fresh DB", async () => {
  if (!canRun || !testClient) return;

  const expected = [
    "users",
    "organizations",
    "org_members",
    "org_invites",
    "runs",
    "specs",
    "tests",
    "manual_tests",
    "manual_test_groups",
    "releases",
    "release_runs",
    "release_manual_tests",
    "release_test_sessions",
    "release_test_session_results",
    "webhooks",
    "scheduled_reports",
    "audit_log",
    "coverage_reports",
    "security_findings",
    "quarantined_tests",
  ];
  const result = await testClient!.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const present = new Set(result.rows.map((r) => r.table_name));
  for (const t of expected) {
    assert.ok(present.has(t), `expected table "${t}" missing after fresh-DB migration apply`);
  }
});

test("migrations: critical indexes exist (race-safe upserts depend on them)", async () => {
  if (!canRun || !testClient) return;

  // Migration 035 added the partial unique index that makes the
  // ON CONFLICT in findOrCreateRun race-safe.  If a future migration
  // drops or renames it, parallel CI workers will silently produce
  // duplicate runs again.
  const result = await testClient!.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'runs'`
  );
  const indexes = new Set(result.rows.map((r) => r.indexname));
  // Just assert SOMETHING with "ci_run" in the name exists — the exact
  // name is implementation detail, but its presence is load-bearing.
  const hasCiRunIndex = Array.from(indexes).some((i) => i.includes("ci_run"));
  assert.ok(hasCiRunIndex, "expected a unique index on (org_id, suite_name, ci_run_id) — see migration 035");
});

test("migrations: RLS is enabled on tenant-scoped tables", async () => {
  if (!canRun || !testClient) return;

  // RLS-on tables: catastrophic if disabled, since the app runs as
  // flakey_app expecting rows to be filtered by current_org_id GUC.
  const tenantTables = ["runs", "specs", "tests", "manual_tests", "webhooks", "audit_log"];
  const result = await testClient!.query<{ tablename: string; rowsecurity: boolean }>(
    `SELECT tablename, rowsecurity FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [tenantTables]
  );
  for (const row of result.rows) {
    assert.equal(row.rowsecurity, true,
      `RLS must be enabled on ${row.tablename} — disabling it would leak data across orgs`);
  }
});

test("migrations: re-applying every migration on the same DB is a no-op (idempotent)", async () => {
  if (!canRun || !testClient) return;

  // Simulates the redeploy case: app already has the schema, but
  // ./migrate.sh runs every migration on every deploy. migrate.sh greps
  // out "already exists" notices, so we mirror that here — re-apply
  // is allowed to fail with that specific error class without breaking
  // production deploys.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
    try {
      await applyMigration(testClient, sql, f);
    } catch (err) {
      const msg = (err as Error).message;
      // "already exists" is the redeploy-no-op signal that migrate.sh
      // explicitly tolerates. Any other re-apply error is real.
      if (!/already exists/i.test(msg)) {
        throw new Error(`migration ${f} is NOT idempotent — re-apply failed: ${msg}`);
      }
    }
  }
});
