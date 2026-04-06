import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../db.js";
import { tenantQuery } from "../db.js";
import { signToken, requireAuth } from "../auth.js";

const router = Router();

/** Get the user's org (first one, or create a personal org). */
async function resolveOrg(userId: number, email: string): Promise<{ orgId: number; orgRole: string }> {
  const membership = await pool.query(
    "SELECT org_id, role FROM org_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1",
    [userId]
  );

  if (membership.rows.length > 0) {
    return { orgId: membership.rows[0].org_id, orgRole: membership.rows[0].role };
  }

  // Check for pending invites
  const invite = await pool.query(
    "SELECT id, org_id, role FROM org_invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1",
    [email]
  );

  if (invite.rows.length > 0) {
    const inv = invite.rows[0];
    await pool.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [inv.org_id, userId, inv.role]
    );
    await pool.query("UPDATE org_invites SET accepted_at = NOW() WHERE id = $1", [inv.id]);
    return { orgId: inv.org_id, orgRole: inv.role };
  }

  // Create a personal org
  const slug = `user-${userId}-${Date.now()}`;
  const org = await pool.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [email.split("@")[0] + "'s Org", slug]
  );
  const orgId = org.rows[0].id;
  await pool.query(
    "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')",
    [orgId, userId]
  );
  return { orgId, orgRole: "owner" };
}

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, email, name, role, password_hash FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole };
    const token = signToken(authUser);

    res.json({ token, user: authUser });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, role",
      [email, hash, name ?? ""]
    );

    const user = result.rows[0];
    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole };
    const token = signToken(authUser);

    res.status(201).json({ token, user: authUser });
  } catch (err) {
    console.error("POST /auth/register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  const orgs = await pool.query(
    `SELECT o.id, o.name, o.slug, om.role
     FROM organizations o JOIN org_members om ON om.org_id = o.id
     WHERE om.user_id = $1 ORDER BY o.name`,
    [req.user!.id]
  );
  res.json({ user: req.user, orgs: orgs.rows });
});

// POST /auth/switch-org — switch active org, returns new JWT
router.post("/switch-org", requireAuth, async (req, res) => {
  try {
    const { orgId } = req.body;
    const membership = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, req.user!.id]
    );

    if (membership.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this organization" });
      return;
    }

    const authUser = { ...req.user!, orgId, orgRole: membership.rows[0].role };
    const token = signToken(authUser);
    res.json({ token, user: authUser });
  } catch (err) {
    console.error("POST /auth/switch-org error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/api-keys
router.get("/api-keys", requireAuth, async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      "SELECT id, key_prefix, label, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user!.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /auth/api-keys error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/api-keys
router.post("/api-keys", requireAuth, async (req, res) => {
  try {
    const label = req.body.label ?? "Untitled key";
    const rawKey = `fk_${crypto.randomBytes(24).toString("hex")}`;
    const prefix = rawKey.slice(0, 8);
    const hash = bcrypt.hashSync(rawKey, 10);

    await tenantQuery(
      req.user!.orgId,
      "INSERT INTO api_keys (user_id, key_hash, key_prefix, label, org_id) VALUES ($1, $2, $3, $4, $5)",
      [req.user!.id, hash, prefix, label, req.user!.orgId]
    );

    res.status(201).json({ key: rawKey, prefix, label });
  } catch (err) {
    console.error("POST /auth/api-keys error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /auth/api-keys/:id
router.delete("/api-keys/:id", requireAuth, async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      "DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /auth/api-keys error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
