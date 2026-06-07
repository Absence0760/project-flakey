import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { tenantQuery, userScopedQuery } from "../db.js";
import { signToken, signRefreshToken, setTokenCookie, clearTokenCookies, requireAuth, normalizeEmail, getJwtSecret } from "../auth.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../email.js";
import { logAudit } from "../audit.js";
import { orgEnforcesSso } from "../sso/config.js";
import { safeLog } from "../log.js";

// Secure default: registration is disabled unless ALLOW_REGISTRATION=true is explicitly set.
const ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === "true";

const router = Router();

/**
 * Pull the refresh token out of either the JSON body or the
 * `flakey_refresh` cookie and verify it server-side. Returns a
 * normalized result so callers branch on a server-controlled value,
 * not on the user-supplied string itself. Callers MUST treat `null`
 * as "no valid refresh token to act on".
 *
 * CodeQL js/user-controlled-bypass flags `if (refreshTokenValue) …`
 * because the user supplies the value. The actual security check
 * is jwt.verify with the server secret — once that succeeds and
 * payload.type === "refresh", the resulting `{ id, jti }` is
 * server-attested, not attacker-forgeable. This helper centralises
 * that check so each route's guard is a `null` test against a
 * verified result.
 */
function extractAndVerifyRefreshToken(
  req: import("express").Request,
): { id: number; jti: string | null; iat: number | null; ssoOrg: number | null } | null {
  let value: string | undefined = req.body?.refreshToken;
  if (!value) {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("flakey_refresh="));
      if (match) value = match.split("=").slice(1).join("=");
    }
  }
  if (!value) return null;
  try {
    const payload = jwt.verify(value, getJwtSecret(), { algorithms: ["HS256"] }) as any;
    if (payload?.type !== "refresh") return null;
    const id = Number(payload.id);
    if (!Number.isFinite(id)) return null;
    return {
      id,
      jti: typeof payload.jti === "string" ? payload.jti : null,
      iat: typeof payload.iat === "number" ? payload.iat : null,
      ssoOrg: typeof payload.ssoOrg === "number" ? payload.ssoOrg : null,
    };
  } catch {
    return null;
  }
}

/** Get the user's org (first one, or create a personal org). */
// Resolve a user's primary org so an auth event can be written to the
// org-scoped audit_log (RLS requires a concrete org_id). Returns null when
// the user has no membership yet — the caller skips the audit rather than
// inventing an org.
async function primaryOrgId(userId: number): Promise<number | null> {
  const r = await pool.query(
    "SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1",
    [userId],
  );
  return r.rows[0]?.org_id ?? null;
}

async function resolveOrg(userId: number, email: string): Promise<{ orgId: number; orgRole: string }> {
  const membership = await pool.query(
    "SELECT org_id, role FROM org_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1",
    [userId]
  );

  if (membership.rows.length > 0) {
    return { orgId: membership.rows[0].org_id, orgRole: membership.rows[0].role };
  }

  // Check for pending invites. Match case-insensitively because admins
  // may have typed "Alice@Example.com" while the user registered as
  // "alice@example.com" — same person, mismatched casing.
  const invite = await pool.query(
    "SELECT id, org_id, role FROM org_invites WHERE LOWER(email) = LOWER($1) AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1",
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

// Per-account lockout knobs.  Defaults match the threat model in
// docs but stay env-configurable so ops can tune them without a
// code change.  LOGIN_LOCKOUT_THRESHOLD = consecutive failures
// before the account is locked.  LOGIN_LOCKOUT_MINUTES = how long
// the account stays locked before it self-unlocks.
const LOGIN_LOCKOUT_THRESHOLD = Math.max(1, Number(process.env.LOGIN_LOCKOUT_THRESHOLD ?? 5));
const LOGIN_LOCKOUT_MINUTES = Math.max(1, Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15));

// Precomputed dummy bcrypt hash used to flatten the unknown-email
// vs wrong-password response-time difference on /auth/login. The
// real login branch runs bcrypt.compareSync (~200ms at cost 12);
// without this, the unknown-email branch returns immediately and
// the timing alone leaks account existence to an attacker.
// crypto.randomBytes seeds the hash so it has no chance of
// matching any real password.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12);

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, email, name, role, password_hash, email_verified, failed_login_attempts, locked_until FROM users WHERE LOWER(email) = $1",
      [email]
    );

    const user = result.rows[0];
    // Preserve the unknown-vs-wrong-password indistinguishability
    // on TWO axes:
    //   1. Response shape — both branches return 401 with the same
    //      body, never 404 or a lockout-shaped 429.
    //   2. Response TIMING — a wrong-password branch runs bcrypt
    //      (~200ms at cost factor 12). If the unknown-email branch
    //      returned immediately the response time alone would tell
    //      an attacker which emails exist, regardless of the body.
    //      Run a fixed-cost bcrypt comparison against a precomputed
    //      dummy hash so both branches incur the same wall-clock
    //      cost before the 401 is returned.
    if (!user) {
      bcrypt.compareSync(password, DUMMY_BCRYPT_HASH);
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Per-account lockout check.  The per-IP authLimiter handles
    // volume from a single source; this guards a single account
    // against a distributed attack that rotates IPs and so flies
    // under the per-IP gate.  Lockout 429 is its own response code
    // so the UI can prompt for password reset rather than just
    // re-rendering the wrong-password message.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      res.status(429).json({
        error: "Account temporarily locked due to repeated failed login attempts. Try again later or reset your password.",
        code: "ACCOUNT_LOCKED",
      });
      return;
    }

    const passwordOk = bcrypt.compareSync(password, user.password_hash);
    if (!passwordOk) {
      // Increment the counter, stamp locked_until if we just crossed
      // the threshold.  Both columns are part of the same UPDATE so
      // there's no window where the counter is updated without the
      // lock taking effect.
      const newCount = (user.failed_login_attempts ?? 0) + 1;
      if (newCount >= LOGIN_LOCKOUT_THRESHOLD) {
        await pool.query(
          `UPDATE users SET failed_login_attempts = $1,
                            locked_until = NOW() + ($2 || ' minutes')::INTERVAL
             WHERE id = $3`,
          [newCount, String(LOGIN_LOCKOUT_MINUTES), user.id]
        );
      } else {
        await pool.query(
          "UPDATE users SET failed_login_attempts = $1 WHERE id = $2",
          [newCount, user.id]
        );
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      res.status(403).json({ error: "Please verify your email before signing in.", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    // Successful login — clear the lockout state so a user who
    // recovered their password isn't penalised for the earlier
    // mis-typed attempts.
    if ((user.failed_login_attempts ?? 0) > 0 || user.locked_until) {
      await pool.query(
        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1",
        [user.id]
      );
    }

    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    // SSO-enforcement (AWS-console-MFA model): a password login into an org that
    // requires SSO still succeeds, but the session is minted restricted
    // (ssoRequired) and requireAuth clamps it until the user completes SSO. We
    // surface ssoRequired + orgSlug so the SPA can send them straight to the IdP.
    const ssoRequired = await orgEnforcesSso(orgId);
    const orgSlug = ssoRequired
      ? (await pool.query("SELECT slug FROM organizations WHERE id = $1", [orgId])).rows[0]?.slug ?? null
      : null;
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole, ssoRequired };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    setTokenCookie(res, token, refreshToken);
    // Audit successful authentication so an account-compromise ticket can be
    // reconstructed. Refresh (/auth/refresh) is intentionally NOT audited — it
    // fires every ~15 min per active session and would drown the signal.
    await logAudit(orgId, user.id, "auth.login", "user", String(user.id), { email: user.email, ssoRequired });
    res.json({ token, refreshToken, user: authUser, ssoRequired, orgSlug });
  } catch (err) {
    console.error("POST /auth/login error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/registration-status — public read of the ALLOW_REGISTRATION
// posture so the SPA landing page can hide "Create an account" CTAs
// when self-serve is disabled. Leaks a single bit of config state
// (registration open or closed) — already discoverable by sending a
// fake register and seeing the 403, so exposing it directly just
// closes the UX dead-end.
//
// Public — no auth required. Bounded by the global API rate limiter
// (no need for the credential-burning authLimiter; this endpoint can't
// be exploited against credentials).
router.get("/registration-status", (_req, res) => {
  res.json({ open: ALLOW_OPEN_REGISTRATION });
});

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password, name, invite_token } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    // Fix 6: Check if open registration is allowed, or if they have an invite
    if (!ALLOW_OPEN_REGISTRATION && !invite_token) {
      // Check if there's a pending invite for this email
      const pendingInvite = await pool.query(
        "SELECT id FROM org_invites WHERE LOWER(email) = $1 AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1",
        [email]
      );
      if (pendingInvite.rows.length === 0) {
        res.status(403).json({ error: "Registration is by invite only. Contact your admin." });
        return;
      }
    }

    const existing = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
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
      console.error("Failed to send verification email:", safeLog(err));
    });

    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    const ssoRequired = await orgEnforcesSso(orgId);
    const orgSlug = ssoRequired
      ? (await pool.query("SELECT slug FROM organizations WHERE id = $1", [orgId])).rows[0]?.slug ?? null
      : null;
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole, ssoRequired };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    setTokenCookie(res, token, refreshToken);
    res.status(201).json({ token, refreshToken, user: authUser, ssoRequired, orgSlug, emailVerificationRequired: REQUIRE_EMAIL_VERIFICATION });
  } catch (err) {
    console.error("POST /auth/register error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/refresh — exchange refresh token for new access token
router.post("/refresh", async (req, res) => {
  try {
    const verified = extractAndVerifyRefreshToken(req);
    if (!verified) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    // Revocation check. Tokens issued before migration 037 don't
    // carry a jti — those legacy tokens stay usable until their
    // natural exp (max 7d) so the upgrade doesn't sign out every
    // active user on deploy.
    if (verified.jti) {
      // userScopedQuery sets app.current_user_id so the
      // revoked_refresh_tokens RLS policy (migration 040) admits the row.
      const revoked = await userScopedQuery(
        verified.id,
        "SELECT 1 FROM revoked_refresh_tokens WHERE jti = $1",
        [verified.jti],
      );
      if (revoked.rowCount && revoked.rowCount > 0) {
        res.status(401).json({ error: "Refresh token has been revoked" });
        return;
      }
    }

    const userResult = await pool.query(
      "SELECT id, email, name, role, sessions_revoked_at FROM users WHERE id = $1",
      [verified.id]
    );
    if (userResult.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const user = userResult.rows[0];

    // Session-revocation watermark. SCIM deactivate/delete (and any future
    // "force sign-out") stamps users.sessions_revoked_at; a refresh token
    // issued before that instant is dead — so deactivation can't be outlived
    // by a still-valid refresh token (which would otherwise resolveOrg into a
    // fresh personal-org session). Tokens with no iat (shouldn't happen for
    // server-signed tokens) are treated as pre-watermark and rejected.
    if (user.sessions_revoked_at) {
      const issuedAtMs = verified.iat ? verified.iat * 1000 : 0;
      if (issuedAtMs < new Date(user.sessions_revoked_at).getTime()) {
        res.status(401).json({ error: "Session has been revoked; please sign in again" });
        return;
      }
    }
    const { orgId, orgRole } = await resolveOrg(user.id, user.email);
    // Preserve which org this session was SSO-authenticated for, and re-derive
    // ssoRequired for the (possibly changed) org: a session satisfies SSO only
    // for the exact org it authenticated against (no cross-org free pass).
    // Break-glass accounts are never restricted.
    const ssoOrg = verified.ssoOrg ?? undefined;
    const ssoRequired = ssoOrg !== orgId && (await orgEnforcesSso(orgId));
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role, orgId, orgRole, ssoOrg, ssoRequired };
    const token = signToken(authUser);
    const newRefresh = signRefreshToken(user.id, { ssoOrg });

    // Refresh-token rotation. Mark the just-consumed jti as
    // revoked so the same refresh token cannot be replayed. If an
    // attacker captures a refresh token but the legitimate user
    // refreshes first, the attacker's subsequent /auth/refresh
    // 401s — self-detection of the compromise.
    if (verified.jti) {
      await userScopedQuery(
        verified.id,
        "INSERT INTO revoked_refresh_tokens (jti, user_id) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING",
        [verified.jti, verified.id],
      );
    }

    setTokenCookie(res, token, newRefresh);
    res.json({ token, refreshToken: newRefresh, user: authUser });
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// POST /auth/logout — clear cookies and revoke the current refresh token
router.post("/logout", async (req, res) => {
  // Logout is idempotent: a missing / invalid / legacy (no-jti)
  // token is a no-op on the revocation side; cookies are cleared
  // regardless. The helper does the server-side verify so the
  // revocation INSERT only fires for a real, server-signed token.
  const verified = extractAndVerifyRefreshToken(req);
  if (verified && verified.jti) {
    await userScopedQuery(
      verified.id,
      "INSERT INTO revoked_refresh_tokens (jti, user_id) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING",
      [verified.jti, verified.id],
    );
  }
  if (verified) {
    const orgId = await primaryOrgId(verified.id);
    if (orgId) await logAudit(orgId, verified.id, "auth.logout", "user", String(verified.id));
  }

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

    // Re-derive SSO enforcement for the org being switched into. A session
    // satisfies SSO only for the exact org it authenticated against, so
    // switching into a *different* enforced org becomes restricted until the
    // user completes SSO for it. Break-glass accounts are never restricted.
    const ssoOrg = req.user!.ssoOrg;
    const ssoRequired = ssoOrg !== orgId && (await orgEnforcesSso(orgId));
    const orgSlug = ssoRequired
      ? (await pool.query("SELECT slug FROM organizations WHERE id = $1", [orgId])).rows[0]?.slug ?? null
      : null;
    const authUser = { ...req.user!, orgId, orgRole: membership.rows[0].role, ssoOrg, ssoRequired };
    const token = signToken(authUser);
    res.json({ token, user: authUser, ssoRequired, orgSlug });
  } catch (err) {
    console.error("POST /auth/switch-org error:", safeLog(err));
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
    console.error("GET /auth/api-keys error:", safeLog(err));
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

    const inserted = await tenantQuery(
      req.user!.orgId,
      "INSERT INTO api_keys (user_id, key_hash, key_prefix, label, org_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [req.user!.id, hash, prefix, label, req.user!.orgId]
    );
    // API-key issuance is a long-lived credential creation — log it
    // for forensics. Detail records the prefix (not the raw key)
    // and the label so an admin reviewing the audit can identify
    // which row the attacker created without needing the secret.
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "auth.api_key.create",
      "api_key",
      String(inserted.rows[0].id),
      { prefix, label },
    );

    res.status(201).json({ key: rawKey, prefix, label });
  } catch (err) {
    console.error("POST /auth/api-keys error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /auth/api-keys/:id
router.delete("/api-keys/:id", requireAuth, async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      "DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id, key_prefix",
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "auth.api_key.delete",
      "api_key",
      String(req.params.id),
      { prefix: result.rows[0].key_prefix },
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /auth/api-keys error:", safeLog(err));
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
    console.error("POST /auth/verify-email error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/resend-verification — resend verification email
router.post("/resend-verification", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, email_verified FROM users WHERE LOWER(email) = $1",
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
      console.error("Failed to send verification email:", safeLog(err));
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/resend-verification error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/forgot-password — send password reset email
router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const result = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);

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
      console.error("Failed to send password reset email:", safeLog(err));
    });
    {
      const orgId = await primaryOrgId(result.rows[0].id);
      if (orgId) await logAudit(orgId, result.rows[0].id, "auth.password_reset_requested", "user", String(result.rows[0].id));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/forgot-password error:", safeLog(err));
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

    {
      const orgId = await primaryOrgId(result.rows[0].id);
      if (orgId) await logAudit(orgId, result.rows[0].id, "auth.password_reset", "user", String(result.rows[0].id));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/reset-password error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
