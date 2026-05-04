import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "./db.js";

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
  return jwt.sign(
    { id: userId, type: "refresh" },
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
      pool.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.key_id]).catch(() => {});

      const memberResult = await pool.query(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [row.org_id, row.user_id]
      );
      const orgRole = memberResult.rows[0]?.role ?? "viewer";

      return {
        id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.user_role,
        orgId: row.org_id,
        orgRole,
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
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // API key
    if (token.startsWith("fk_")) {
      verifyApiKey(token).then((user) => {
        if (!user) {
          res.status(401).json({ error: "Invalid API key" });
          return;
        }
        req.user = user;
        next();
      }).catch(() => {
        res.status(401).json({ error: "Authentication failed" });
      });
      return;
    }

    // JWT from header
    const user = verifyToken(token);
    if (user) {
      req.user = user;
      next();
      return;
    }
  }

  // httpOnly cookie
  const cookieToken = parseCookie(req.headers.cookie, "flakey_token");
  if (cookieToken) {
    const user = verifyToken(cookieToken);
    if (user) {
      req.user = user;
      next();
      return;
    }
  }

  res.status(401).json({ error: "Authentication required" });
}
