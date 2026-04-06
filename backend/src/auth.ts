import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import pool from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "flakey-dev-secret-change-me";
const TOKEN_EXPIRY = "7d";

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
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return null;
  }
}

async function verifyApiKey(key: string): Promise<AuthUser | null> {
  const prefix = key.slice(0, 8);
  // Uses SECURITY DEFINER function to bypass RLS for bootstrap
  const rows = await pool.query(
    "SELECT * FROM lookup_api_key($1)",
    [prefix]
  );

  for (const row of rows.rows) {
    if (bcrypt.compareSync(key, row.key_hash)) {
      // Update last_used_at (fire-and-forget, uses raw pool since we know the key_id)
      pool.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.key_id]).catch(() => {});

      // Look up org role
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

/**
 * Middleware that requires authentication via JWT or API key.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // API key (prefixed with fk_)
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

    // JWT token
    const user = verifyToken(token);
    if (user) {
      req.user = user;
      next();
      return;
    }
  }

  // Check cookie
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("flakey_token="));
    if (match) {
      const token = match.split("=")[1];
      const user = verifyToken(token);
      if (user) {
        req.user = user;
        next();
        return;
      }
    }
  }

  res.status(401).json({ error: "Authentication required" });
}
