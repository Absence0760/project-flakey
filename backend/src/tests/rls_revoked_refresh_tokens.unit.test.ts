/**
 * RLS coverage for revoked_refresh_tokens (migration 040).
 *
 * The table is per-user, not per-org — set_config sets app.current_user_id
 * via userScopedQuery in db.ts. This test confirms:
 *   1. A row inserted under user A is invisible when reading as user B.
 *   2. A row insert WITH CHECK rejects when user_id != app.current_user_id.
 *
 * Skipped if the DB is unreachable.
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
let userA = 0;
let userB = 0;
const jtiA = `test-jti-A-${Date.now()}`;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });
  try {
    await pool.query("SELECT 1");
    canRun = true;
  } catch (err) {
    console.warn(`[rls-revoked] could not connect, skipping: ${(err as Error).message}`);
    return;
  }

  // Seed two users (`users` has no RLS).
  const a = await pool.query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'A') RETURNING id",
    [`rls-revoked-a-${Date.now()}@test.local`]
  );
  userA = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'B') RETURNING id",
    [`rls-revoked-b-${Date.now()}@test.local`]
  );
  userB = b.rows[0].id;

  // Insert a revoked-jti row under user A's scope.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userA)]);
    await client.query(
      "INSERT INTO revoked_refresh_tokens (jti, user_id) VALUES ($1, $2)",
      [jtiA, userA]
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

after(async () => {
  if (!pool) return;
  if (canRun) {
    // Clean up under each user's own scope.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userA)]);
      await client.query("DELETE FROM revoked_refresh_tokens WHERE user_id = $1", [userA]);
      await client.query("COMMIT");
      await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [userA, userB]);
    } finally {
      client.release();
    }
  }
  await pool.end();
});

test("user B cannot SELECT user A's revoked-jti row (USING blocks)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userB)]);
    const found = await client.query(
      "SELECT 1 FROM revoked_refresh_tokens WHERE jti = $1",
      [jtiA]
    );
    assert.equal(found.rowCount, 0, "user B must not see user A's revoked jti");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("user B cannot INSERT a row claiming user_id = A (WITH CHECK blocks)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userB)]);
    await assert.rejects(
      client.query(
        "INSERT INTO revoked_refresh_tokens (jti, user_id) VALUES ($1, $2)",
        [`evil-${Date.now()}`, userA]
      ),
      /row-level security/i,
      "WITH CHECK must reject user B writing a user_id = A row"
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("user A can SELECT and INSERT their own row (positive control)", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userA)]);
    const found = await client.query(
      "SELECT 1 FROM revoked_refresh_tokens WHERE jti = $1",
      [jtiA]
    );
    assert.equal(found.rowCount, 1, "user A must see their own jti row");
    const inserted = await client.query(
      "INSERT INTO revoked_refresh_tokens (jti, user_id) VALUES ($1, $2) RETURNING jti",
      [`legit-${Date.now()}`, userA]
    );
    assert.ok(inserted.rows[0]?.jti, "user A's own INSERT should succeed");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

// ── Migration 052: maintenance-scoped DELETE (retention prune) ────────────

test("app.maintenance='on' can DELETE any user's aged-out row; without it, scope holds", async (t) => {
  if (!canRun) { t.skip("DB unreachable"); return; }
  const oldJti = `test-old-${Date.now()}`;

  // Seed an aged-out row under user A's scope.
  {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userA)]);
      await client.query(
        "INSERT INTO revoked_refresh_tokens (jti, user_id, revoked_at) VALUES ($1, $2, NOW() - INTERVAL '30 days')",
        [oldJti, userA]
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  // User B, WITHOUT maintenance, cannot delete user A's row — per-user scope
  // is unchanged by the new permissive policy.
  {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1::text, true)", [String(userB)]);
      const res = await client.query("DELETE FROM revoked_refresh_tokens WHERE jti = $1", [oldJti]);
      assert.equal(res.rowCount, 0, "user B must not be able to delete user A's row");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  // The maintenance path (app.maintenance='on', no user scope) prunes it.
  {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.maintenance', 'on', true)");
      const res = await client.query(
        "DELETE FROM revoked_refresh_tokens WHERE revoked_at < NOW() - INTERVAL '14 days' AND jti = $1",
        [oldJti]
      );
      assert.equal(res.rowCount, 1, "maintenance prune must delete the aged-out row");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
});
