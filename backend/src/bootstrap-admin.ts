import type pg from "pg";
import bcrypt from "bcryptjs";

/**
 * Env-gated first-admin bootstrap.
 *
 * A fresh install ships with NO users. To make the very first sign-in
 * possible without hand-crafting a row, ops set:
 *
 *   FLAKEY_BOOTSTRAP_ADMIN_EMAIL
 *   FLAKEY_BOOTSTRAP_ADMIN_PASSWORD
 *
 * When BOTH are present, boot ensures that admin exists — creating the
 * user, a personal org, and an `owner` membership the same way
 * POST /auth/register's resolveOrg does (bcrypt cost 12, role 'admin'
 * on the user row, 'owner' on the membership). When either is unset the
 * function no-ops silently — this is the default and the only safe one,
 * since no default credentials are ever shipped.
 *
 * It is idempotent and safe to run on every boot: if a user with that
 * email already exists we leave it untouched — we never reset an
 * existing password.
 */
export async function bootstrapAdmin(pool: pg.Pool): Promise<void> {
  const email = process.env.FLAKEY_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.FLAKEY_BOOTSTRAP_ADMIN_PASSWORD;

  // Default path: no bootstrap requested. Stay quiet.
  if (!email || !password) return;

  // Already provisioned (this boot or a prior one) — never touch an
  // existing account's password or role.
  // Log only the email domain, never the full address — these lines land in
  // stdout/CloudWatch where the admin's email would otherwise be discoverable
  // via log search (CWE-532).
  const emailDomain = email.split("@")[1] ?? "unknown";

  const existing = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
  if (existing.rows.length > 0) {
    console.log(`Bootstrap admin (${emailDomain}) already exists — leaving it untouched.`);
    return;
  }

  // Mirror POST /auth/register: bcrypt cost 12, email pre-verified (the
  // operator supplied it out-of-band), role 'admin' on the user row.
  const hash = bcrypt.hashSync(password, 12);

  // All three inserts in one transaction. A partial write (user created but
  // org/membership not) would strand the admin with no org — and because
  // the existence check above keys on the email, a later boot would see the
  // user and skip, leaving them permanently unusable. Atomicity prevents
  // that. (resolveOrg in auth.ts does the same three-step create; this is
  // the standalone, transactional version.)
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, name, role, email_verified)
       VALUES ($1, $2, 'Admin', 'admin', true)
       RETURNING id`,
      [email, hash],
    );
    const userId = userResult.rows[0].id;

    // Personal org + owner membership, matching resolveOrg's shape.
    const slug = `user-${userId}-${Date.now()}`;
    const orgResult = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [email.split("@")[0] + "'s Org", slug],
    );
    const orgId = orgResult.rows[0].id;
    await client.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, userId],
    );
    await client.query("COMMIT");
    console.log(`Bootstrap admin (${emailDomain}) created (role admin, owner of org ${orgId}).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* connection may be gone */ });
    throw err;
  } finally {
    client.release();
  }
}
