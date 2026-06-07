import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pool, { tenantQuery } from "./db.js";

// Fix 1: Warn in dev, fail in prod.
//
// The boot guard in index.ts already refuses to start when
// NODE_ENV=production and JWT_SECRET isn't set. This second guard
// makes the fallback fail at module-load time if any other entry
// point (a script, a test harness, a future standalone worker)
// imports auth.ts directly without going through index.ts. The
// previous form silently substituted the dev string in any
// no-JWT_SECRET environment, which was safe in practice but lost
// the prod guarantee the moment a non-index.ts entry point appears.
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  return "flakey-dev-secret-change-me";
})();

// Exported for callers in routes/auth.ts that verify refresh tokens
// outside the requireAuth middleware path. Centralising the constant
// avoids the previous pattern of repeating the dev-fallback literal at
// each callsite — the prod-mode throw fires once at import time, not
// per call.
export function getJwtSecret(): string {
  return JWT_SECRET;
}
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
  // Set only for a support "view as org" session (see signSupportToken /
  // routes/support.ts). When true: `id` is the support actor, `orgId` is the
  // org being viewed (the actor is NOT a member of it), and requireAuth
  // restricts the request to GET on an allow-listed read surface.
  isSupportRead?: boolean;
  supportReason?: string;
  // SSO enforcement (AWS-console-MFA model). `sso` = this session was
  // established via SSO. `ssoRequired` = the active org enforces SSO and this
  // session was NOT established via SSO, so requireAuth clamps it to a minimal
  // surface until the user re-authenticates through their IdP. Password login
  // still succeeds (no hard block) — it just lands restricted.
  sso?: boolean;
  ssoRequired?: boolean;
}

// A support session is intentionally brief — long enough to triage one
// ticket, short enough that a leaked token is low-value.
const SUPPORT_EXPIRY = "30m";

// The ONLY resources a read-only support session may touch — the diagnostic /
// repro surface. Deny-by-default: anything not listed (integration config and
// secrets under /jira /pagerduty /connectivity /orgs, /auth, /support itself,
// /webhooks, the upload + live write paths) is refused even for GET, so a
// support token can't read an org's secrets or escalate. Keyed on the router
// mount prefix, which Express exposes as req.baseUrl inside requireAuth.
const SUPPORT_READ_BASEURLS = new Set([
  "/runs", "/errors", "/flaky", "/stats", "/tests", "/suites", "/compare",
  "/audit", "/releases", "/manual-tests", "/manual-test-groups", "/notes",
  "/quarantine", "/views", "/coverage", "/a11y", "/visual", "/security",
  "/ui-coverage", "/predict",
]);

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id, email: user.email, name: user.name, role: user.role,
      orgId: user.orgId, orgRole: user.orgRole,
      // Only emit the SSO flags when set, so non-SSO sessions keep their
      // existing compact token shape.
      ...(user.sso ? { sso: true } : {}),
      ...(user.ssoRequired ? { ssoRequired: true } : {}),
    },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

/**
 * Mint a short-lived, read-only support session token: the actor (a platform
 * support user) "views as" the target org. `id` stays the support actor (so
 * the audit trail attributes reads to a real person), `orgId` is the org being
 * viewed. requireAuth enforces read-only + the allow-listed surface; this
 * function only encodes the claim.
 */
export function signSupportToken(actor: AuthUser, targetOrgId: number, reason: string): string {
  return jwt.sign(
    {
      id: actor.id, email: actor.email, name: actor.name, role: actor.role,
      orgId: targetOrgId, orgRole: "support", supportRead: true, reason,
    },
    JWT_SECRET,
    { expiresIn: SUPPORT_EXPIRY }
  );
}

export function signRefreshToken(userId: number, opts?: { sso?: boolean }): string {
  // jti = unique id per refresh token, so /auth/logout and the
  // refresh-token rotation in /auth/refresh can mark a specific
  // token as revoked without invalidating every refresh ever
  // issued to the user. crypto.randomUUID() is collision-safe
  // and is the standard jti shape per RFC 7519.
  //
  // `sso` records that the session was established via SSO, so a refresh
  // re-derives ssoRequired correctly (an SSO session must not be downgraded to
  // restricted on refresh just because its org enforces SSO).
  return jwt.sign(
    { id: userId, type: "refresh", jti: crypto.randomUUID(), ...(opts?.sso ? { sso: true } : {}) },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
}

// jsonwebtoken v9 defaults reject alg:"none", but the defence is
// implicit and version-dependent. Pinning algorithms to HS256 makes
// the invariant explicit so a future SDK upgrade can't silently
// re-enable insecure algorithms.
const JWT_VERIFY_OPTS: jwt.VerifyOptions = { algorithms: ["HS256"] };

function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTS) as any;
    if (payload.type === "refresh") return null; // Don't accept refresh tokens as access tokens
    if (payload.supportRead === true) {
      // Read-only support session. Mark it so requireAuth validates the actor
      // is still a support user (not org membership) and clamps the surface.
      return {
        id: payload.id, email: payload.email, name: payload.name, role: payload.role,
        orgId: payload.orgId, orgRole: "support",
        isSupportRead: true, supportReason: typeof payload.reason === "string" ? payload.reason : "",
      };
    }
    return payload as AuthUser;
  } catch {
    return null;
  }
}

async function verifyApiKey(key: string): Promise<AuthUser | null> {
  const prefix = key.slice(0, 8);
  // verify_api_key (migration 041) does the bcrypt comparison
  // server-side via pgcrypto and returns ONLY the matched row's
  // identity columns — it never exposes key_hash to the application.
  // The previous lookup_api_key path returned the hash and let any
  // flakey_app caller enumerate prefixes for offline cracking.
  const rows = await pool.query(
    "SELECT * FROM verify_api_key($1, $2)",
    [prefix, key],
  );
  const row = rows.rows[0];
  if (!row) return null;

  // The api_keys table has FORCE ROW LEVEL SECURITY (migration 004)
  // and a tenancy policy on org_id; a plain pool.query without
  // set_config('app.current_org_id', …) silently UPDATEs zero rows.
  // Route through tenantQuery scoped to the api-key's own org so the
  // RLS policy admits the write.
  //
  // Fire-and-forget — the `last_used_at` write is cosmetic (audit
  // dashboard freshness) and should never block the request. Log
  // failures though: a systematic RLS misconfiguration or connection
  // exhaustion needs to surface somewhere, not silently leave every
  // api_keys row's last_used_at stuck at NULL forever.
  tenantQuery(
    row.org_id,
    "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1",
    [row.key_id],
  ).catch((err) => {
    console.error("[api-key] last_used_at update failed:", err);
  });

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
  // Server-controlled flag: true only when verifyApiKey actually
  // returned a candidate. Don't re-derive the auth path from
  // `authHeader.startsWith("Bearer fk_")` later — that would let a
  // user smuggle `Authorization: Bearer fk_…` past a still-valid
  // cookie session to skip the staleness check below.
  let authedViaApiKey = false;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.startsWith("fk_")) {
      candidate = await verifyApiKey(token).catch(() => null);
      if (candidate) authedViaApiKey = true;
    } else {
      candidate = verifyToken(token);
    }
    // Explicit Bearer auth: succeeds or fails on its own merits. Do
    // NOT fall back to cookie auth — a revoked API key + a still-valid
    // session cookie must reject, otherwise revocation isn't honoured
    // when the two are sent together (browser tab with a stale key).
  } else {
    // Always call verifyToken — passing "" (no cookie present) returns
    // null via the catch, same as a malformed token. The earlier
    // `if (cookieToken) candidate = verifyToken(...)` form gated a
    // sensitive action on a user-controlled value, which CodeQL flags
    // as js/user-controlled-bypass — same shape as the three b9735aa
    // refactored away. The !candidate check below is the real gate.
    const cookieToken = parseCookie(req.headers.cookie, "flakey_token") ?? "";
    candidate = verifyToken(cookieToken);
  }

  if (!candidate) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Session-staleness check: re-read org_members on every request.
  // Skip only when the candidate actually came from verifyApiKey —
  // that path resolves orgRole from the live row, so its candidate
  // is non-stale by construction. The JWT/cookie paths carry
  // sign-time claims and need the re-read.
  if (candidate.isSupportRead) {
    // Support "view as org" session: the actor is NOT a member of the org
    // being viewed, so the membership re-read above doesn't apply. Re-validate
    // the platform support flag instead, so revoking is_support kills live
    // support sessions on their next request (same staleness guarantee).
    // Fail closed (500) on a DB error rather than hang the request — this is
    // an async middleware, so a thrown error wouldn't reach an error handler.
    let sup;
    try {
      sup = await pool.query("SELECT 1 FROM users WHERE id = $1 AND is_support = true", [candidate.id]);
    } catch (err) {
      console.error("requireAuth: support re-validation query failed:", err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    if (sup.rows.length === 0) {
      res.status(401).json({ error: "Support access is no longer valid" });
      return;
    }
    // Clamp the surface: read-only, allow-listed resources only. The active
    // org-scoping is enforced downstream by RLS via tenantQuery(candidate.orgId).
    //
    // NOTE: this GET/HEAD-only check is the AUTHORITATIVE write gate for a
    // support session. Route handlers guard writes with `orgRole === "viewer"`,
    // which a support session (orgRole "support") does NOT trip — so do not
    // rely on those route-level guards to block support writes. If you add a
    // resource to SUPPORT_READ_BASEURLS, this check (not the route) is what
    // keeps the session read-only.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(403).json({ error: "Support sessions are read-only" });
      return;
    }
    if (!SUPPORT_READ_BASEURLS.has(req.baseUrl)) {
      res.status(403).json({ error: "This resource is not available in a support session" });
      return;
    }
  } else if (!authedViaApiKey) {
    // Session-staleness check: re-read org_members on every request.
    // Skip only when the candidate actually came from verifyApiKey —
    // that path resolves orgRole from the live row, so its candidate
    // is non-stale by construction. The JWT/cookie paths carry
    // sign-time claims and need the re-read.
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

  // SSO-enforcement clamp (AWS-console-MFA model). A password/cookie session in
  // an org that requires SSO is admitted but restricted: it may only read
  // /auth/me (so the SPA can detect the requirement + find the org slug) — every
  // other resource is refused with SSO_REQUIRED until the user re-authenticates
  // through their IdP (which mints an unrestricted `sso` session). API-key and
  // support sessions never carry ssoRequired, so they're unaffected.
  if (candidate.ssoRequired) {
    const isMe = req.method === "GET" && req.baseUrl === "/auth" && req.path === "/me";
    if (!isMe) {
      res.status(403).json({
        error: "This organization requires single sign-on. Please sign in with SSO.",
        code: "SSO_REQUIRED",
        orgId: candidate.orgId,
      });
      return;
    }
  }

  req.user = candidate;
  next();
}
