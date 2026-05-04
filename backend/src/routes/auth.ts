import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { tenantQuery } from "../db.js";
import { signToken, signRefreshToken, setTokenCookie, clearTokenCookies, requireAuth } from "../auth.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../email.js";

// Secure default: registration is disabled unless ALLOW_REGISTRATION=true is explicitly set.
const ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === "true";

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
      "SELECT id, email, name, role, password_hash, email_verified FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      res.status(403).json({ error: "Please verify your email before signing in.", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    setTokenCookie(res, token, refreshToken);
    res.json({ token, refreshToken, user: authUser });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, invite_token } = req.body;

    // Fix 6: Check if open registration is allowed, or if they have an invite
    if (!ALLOW_OPEN_REGISTRATION && !invite_token) {
      // Check if there's a pending invite for this email
      const pendingInvite = await pool.query(
        "SELECT id FROM org_invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1",
        [email]
      );
      if (pendingInvite.rows.length === 0) {
        res.status(403).json({ error: "Registration is by invite only. Contact your admin." });
        return;
      }
    }

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const hash = bcrypt.hashSync(password, 12);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, email_verified, email_verification_token, email_verification_expires_at)
       VALUES ($1, $2, $3, false, $4, $5) RETURNING id, email, name, role`,
      [email, hash, name ?? "", verificationToken, verificationExpiry]
    );

    const user = result.rows[0];

    // Send verification email (don't block registration if it fails)
    sendVerificationEmail(email, verificationToken).catch((err) => {
      console.error("Failed to send verification email:", err);
    });

    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    setTokenCookie(res, token, refreshToken);
    res.status(201).json({ token, refreshToken, user: authUser, emailVerificationRequired: REQUIRE_EMAIL_VERIFICATION });
  } catch (err) {
    console.error("POST /auth/register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/refresh — exchange refresh token for new access token
router.post("/refresh", async (req, res) => {
  try {
    // Check cookie first, then body
    const cookieHeader = req.headers.cookie;
    let refreshTokenValue = req.body.refreshToken;
    if (!refreshTokenValue && cookieHeader) {
      const match = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("flakey_refresh="));
      if (match) refreshTokenValue = match.split("=").slice(1).join("=");
    }

    if (!refreshTokenValue) {
      res.status(400).json({ error: "Refresh token required" });
      return;
    }

    const payload = jwt.verify(refreshTokenValue, process.env.JWT_SECRET ?? "flakey-dev-secret-change-me") as any;
    if (payload.type !== "refresh") {
      res.status(401).json({ error: "Invalid refresh token" });
      return;
    }

    const userResult = await pool.query(
      "SELECT id, email, name, role FROM users WHERE id = $1",
      [payload.id]
    );
    if (userResult.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const user = userResult.rows[0];
    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole };
    const token = signToken(authUser);
    const newRefresh = signRefreshToken(user.id);

    setTokenCookie(res, token, newRefresh);
    res.json({ token, refreshToken: newRefresh, user: authUser });
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// POST /auth/logout — clear cookies
router.post("/logout", (_req, res) => {
  clearTokenCookies(res);
  res.json({ ok: true });
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

// POST /auth/verify-email — verify email with token
router.post("/verify-email", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: "Verification token is required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, email FROM users WHERE email_verification_token = $1 AND email_verification_expires_at > NOW()",
      [token]
    );

    if (result.rows.length === 0) {
      res.status(400).json({ error: "Invalid or expired verification token" });
      return;
    }

    await pool.query(
      "UPDATE users SET email_verified = true, email_verification_token = NULL, email_verification_expires_at = NULL WHERE id = $1",
      [result.rows[0].id]
    );

    res.json({ ok: true, email: result.rows[0].email });
  } catch (err) {
    console.error("POST /auth/verify-email error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/resend-verification — resend verification email
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, email_verified FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0 || result.rows[0].email_verified) {
      // Don't reveal whether the email exists or is already verified
      res.json({ ok: true });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      "UPDATE users SET email_verification_token = $1, email_verification_expires_at = $2 WHERE id = $3",
      [token, expiry, result.rows[0].id]
    );

    // Fire-and-forget: SMTP failures (e.g. broken mail server) must NOT
    // turn into a 500 response, because that would leak whether the
    // email exists vs not (the unknown-email path short-circuits with
    // 200 above).  Log the error and respond ok regardless.
    sendVerificationEmail(email, token).catch((err) => {
      console.error("Failed to send verification email:", err);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/resend-verification error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/forgot-password — send password reset email
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const result = await pool.query("SELECT id FROM users WHERE email = $1", [email]);

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      res.json({ ok: true });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "UPDATE users SET password_reset_token = $1, password_reset_expires_at = $2 WHERE id = $3",
      [token, expiry, result.rows[0].id]
    );

    // Fire-and-forget: same enumeration-resistance reasoning as
    // resend-verification.  An SMTP outage must not cause forgot-
    // password to return 500 for known emails while continuing to
    // return 200 for unknown ones.
    sendPasswordResetEmail(email, token).catch((err) => {
      console.error("Failed to send password reset email:", err);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/forgot-password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/reset-password — reset password with token
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: "Token and new password are required" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_expires_at > NOW()",
      [token]
    );

    if (result.rows.length === 0) {
      res.status(400).json({ error: "Invalid or expired reset token" });
      return;
    }

    const hash = bcrypt.hashSync(password, 12);
    await pool.query(
      "UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = $2",
      [hash, result.rows[0].id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/reset-password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
