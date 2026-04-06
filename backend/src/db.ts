import pg from "pg";

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "flakey_app",
  password: process.env.DB_PASSWORD ?? "flakey_app",
  database: process.env.DB_NAME ?? "flakey",
});

export default pool;

/**
 * Run a query scoped to an organization via RLS.
 * Wraps in a transaction so set_config is scoped and cannot leak to other pool users.
 */
export async function tenantQuery(
  orgId: number,
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run multiple queries in a single transaction scoped to an organization.
 */
export async function tenantTransaction(
  orgId: number,
  fn: (client: pg.PoolClient) => Promise<void>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
