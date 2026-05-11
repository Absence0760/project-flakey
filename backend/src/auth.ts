import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool, { tenantQuery } from "./db.js";

// Fix 1: Warn in dev, fail in prod (handled in index.ts)
const JWT_SECRET = process.env.JWT_SECRET ?? "flakey-dev-secret-change-me";
// Fix 5: Short-lived access token + longer refresh token
const ACCESS_EXPIRY = "1h";
const REFRESH_EXPIRY = "7d";

/**
 * Canonicalize an email address before any DB lookup or insert.
 *
 * Per RFC 5321 the local-part is technically case-sensitive, but no
 * mainstream provider treats it that way. Storing — and matching —
 * verbatim has bitten us in three separate ways:
 *   1. Login: user registered alice@x.com, types Alice@X.com, gets 401.
 *   2. Duplicate accounts: alice@x.com and Alice@X.com slip past the
 *      UNIQUE constraint as separate rows with separate password hashes.
 *   3. Invite + forgot-password: lookups miss when casing differs from
 *      what the admin or user originally typed.
 *
 * Use normalizeEmail() at every entry point (register/login/invite/
 * forgot-password/resend-verification). Returns "" for null/undefined
 * so callers can chain into existing empty-check guards.
 */
export function normalizeEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  orgId: number;
  orgRole: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId, orgRole: user.orgRole },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

export function signRefreshToken(userId: number): string {
  // jti = unique id per refresh token, so /auth/logout and the
  // refresh-token rotation in /auth/refresh can mark a specific
  // token as revoked without invalidating every refresh ever
  // issued to the user. crypto.randomUUID() is collision-safe
  // and is the standard jti shape per RFC 7519.
  return jwt.sign(
    { id: userId, type: "refresh", jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
}

function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    if (payload.type === "refresh") return null; // Don't accept refresh tokens as access tokens
    return payload as AuthUser;
  } catch {
    return null;
  }
}

function verifyRefreshToken(token: string): { id: number } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    if (payload.type !== "refresh") return null;
    return { id: payload.id };
  } catch {
    return null;
  }
}

async function verifyApiKey(key: string): Promise<AuthUser | null> {
  const prefix = key.slice(0, 8);
  const rows = await pool.query("SELECT * FROM lookup_api_key($1)", [prefix]);

  for (const row of rows.rows) {
    if (bcrypt.compareSync(key, row.key_hash)) {
      // The api_keys table has FORCE ROW LEVEL SECURITY (migration 004)
      // and a tenancy policy on org_id; a plain pool.query without
      // set_config('app.current_org_id', …) silently UPDATEs zero rows.
      // Route through tenantQuery scoped to the api-key's own org so the
      // RLS policy admits the write.
      tenantQuery(
        row.org_id,
        "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1",
        [row.key_id],
      ).catch(() => {});

      const memberResult = await pool.query(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [row.org_id, row.user_id]
      );
      // If the user has been removed from the org their key was
      // issued for, refuse the key entirely. Previously this path
      // defaulted to "viewer", which silently downgraded a kicked
      // member to read-only rather than logging them out — a
      // removed member must have NO access, not lesser access.
      if (memberResult.rows.length === 0) return null;

      return {
        id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.user_role,
        orgId: row.org_id,
        orgRole: memberResult.rows[0].role,
      };
    }
  }
  return null;
}

// Fix 4: Set httpOnly cookie with the token
export function setTokenCookie(res: Response, token: string, refreshToken: string): void {
  const IS_PROD = process.env.NODE_ENV === "production";
  res.cookie("flakey_token", token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
    maxAge: 60 * 60 * 1000, // 1 hour
    path: "/",
  });
  res.cookie("flakey_refresh", refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
  });
}

export function clearTokenCookies(res: Response): void {
  res.clearCookie("flakey_token", { path: "/" });
  res.clearCookie("flakey_refresh", { path: "/" });
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? match.split("=").slice(1).join("=") : null;
}

/**
 * Middleware that requires authentication via:
 * 1. Authorization: Bearer <api_key> (fk_ prefix)
 * 2. Authorization: Bearer <jwt>
 * 3. httpOnly cookie (flakey_token)
 *
 * On every accepted credential, re-validates org_members so a
 * kicked-out member or a downgraded role takes effect immediately
 * — JWTs carry orgId+orgRole baked in at sign-time, which would
 * otherwise leave a removed user with full access until exp.
 * verifyApiKey handles its own membership check internally and
 * returns null when the user is no longer in the org.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  let candidate: AuthUser | null = null;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.startsWith("fk_")) {
      candidate = await verifyApiKey(token).catch(() => null);
    } else {
      candidate = verifyToken(token);
    }
    // Explicit Bearer auth: succeeds or fails on its own merits. Do
    // NOT fall back to cookie auth — a revoked API key + a still-valid
    // session cookie must reject, otherwise revocation isn't honoured
    // when the two are sent together (browser tab with a stale key).
  } else {
    const cookieToken = parseCookie(req.headers.cookie, "flakey_token");
    if (cookieToken) candidate = verifyToken(cookieToken);
  }

  if (!candidate) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Session-staleness check: re-read org_members on every request.
  // Skip when verifyApiKey already populated `candidate` — the API
  // key path resolves orgRole from the live row above, so its
  // candidate is non-stale by construction. The JWT/cookie paths
  // carry sign-time claims and need the re-read.
  if (!authHeader?.startsWith("Bearer fk_")) {
    const member = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [candidate.orgId, candidate.id],
    );
    if (member.rows.length === 0) {
      res.status(401).json({ error: "Session is no longer valid; please sign in again" });
      return;
    }
    // Refresh orgRole from current DB state so a downgrade from
    // owner → viewer takes effect on the next request, not at JWT
    // exp. role-gated route handlers (e.g. requireAdmin) consult
    // req.user.orgRole — they need the current value, not the
    // sign-time snapshot.
    candidate.orgRole = member.rows[0].role;
  }

  req.user = candidate;
  next();
}
