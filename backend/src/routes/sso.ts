import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { signToken, signRefreshToken, setTokenCookie, getJwtSecret } from "../auth.js";
import { logAudit } from "../audit.js";
import {
  orgIdBySlug,
  loadSsoConfig,
  saveSsoConfig,
  resolveSsoUser,
  SsoLoginError,
  type SsoConfigInput,
} from "../sso/config.js";
import {
  generatePkce,
  randomToken,
  buildAuthorizeUrl,
  exchangeCode,
  verifyIdToken,
} from "../sso/oidc.js";

// Whole-feature flag (proposal: "each behind a flag"). SSO is OFF unless an
// operator opts in. When off, every SSO route returns a clean 404 so the
// frontend can hide the entry point and nothing half-wires.
const SSO_ENABLED = process.env.FLAKEY_SSO_ENABLED === "true";

const FRONTEND_URL = (process.env.FRONTEND_URL ?? "http://localhost:7778").replace(/\/+$/, "");
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const REDIRECT_URI = `${PUBLIC_API_URL}/auth/sso/callback`;

// The login transaction (state/nonce/PKCE verifier) is carried in a signed,
// httpOnly cookie rather than server state — stateless across ECS tasks and
// tamper-evident (HS256 with the app secret). 10-minute lifetime bounds replay.
const TX_COOKIE = "flakey_sso_tx";
const TX_EXPIRY = "10m";

interface TxPayload {
  state: string;
  nonce: string;
  cv: string; // PKCE code_verifier
  org: number;
  rt: string; // post-login return path (relative, validated)
}

function setTxCookie(res: Response, payload: TxPayload): void {
  const IS_PROD = process.env.NODE_ENV === "production";
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: TX_EXPIRY });
  res.cookie(TX_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax", // must survive the top-level redirect back from the IdP
    maxAge: 10 * 60 * 1000,
    path: "/auth/sso",
  });
}

function readTxCookie(req: Request): TxPayload | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${TX_COOKIE}=`));
  if (!match) return null;
  const value = match.split("=").slice(1).join("=");
  try {
    return jwt.verify(value, getJwtSecret(), { algorithms: ["HS256"] }) as TxPayload;
  } catch {
    return null;
  }
}

function clearTxCookie(res: Response): void {
  res.clearCookie(TX_COOKIE, { path: "/auth/sso" });
}

// Only relative, single-segment-rooted paths are accepted as a return target,
// so an attacker can't use ?returnTo= as an open redirect to another origin.
function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

function requireSsoEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!SSO_ENABLED) {
    res.status(404).json({ error: "SSO is not enabled on this instance", code: "SSO_DISABLED" });
    return;
  }
  next();
}

// ===========================================================================
// Public login flow — mounted at /auth/sso (no router-level requireAuth).
// ===========================================================================
const loginRouter = Router();
loginRouter.use(requireSsoEnabled);

// GET /auth/sso/:orgSlug/status — is SSO available for this org? Public so the
// login page can show/hide the "Sign in with SSO" entry. Leaks only whether an
// org has SSO enabled (already inferable by hitting /start), nothing sensitive.
loginRouter.get("/:orgSlug/status", async (req, res) => {
  try {
    const orgId = await orgIdBySlug(req.params.orgSlug);
    if (orgId === null) {
      res.json({ enabled: false });
      return;
    }
    const cfg = await loadSsoConfig(orgId, false);
    res.json({ enabled: !!cfg?.enabled, protocol: cfg?.protocol ?? null });
  } catch (err) {
    console.error("GET /auth/sso/:orgSlug/status error:", err);
    res.json({ enabled: false });
  }
});

// GET /auth/sso/:orgSlug/start — begin an OIDC Authorization-Code + PKCE flow.
loginRouter.get("/:orgSlug/start", async (req, res) => {
  try {
    const orgId = await orgIdBySlug(req.params.orgSlug);
    if (orgId === null) {
      res.status(404).json({ error: "Unknown organization" });
      return;
    }
    const cfg = await loadSsoConfig(orgId, true);
    // Fail closed: SSO must be enabled, OIDC, and fully configured.
    if (!cfg || !cfg.enabled || cfg.protocol !== "oidc" || !cfg.oidcIssuer || !cfg.oidcClientId) {
      res.status(404).json({ error: "SSO is not configured for this organization" });
      return;
    }

    const { verifier, challenge } = generatePkce();
    const state = randomToken();
    const nonce = randomToken();
    const returnTo = safeReturnPath(req.query.returnTo);

    setTxCookie(res, { state, nonce, cv: verifier, org: orgId, rt: returnTo });

    const url = await buildAuthorizeUrl({
      issuer: cfg.oidcIssuer,
      clientId: cfg.oidcClientId,
      redirectUri: REDIRECT_URI,
      state,
      nonce,
      codeChallenge: challenge,
    });
    res.redirect(url);
  } catch (err) {
    // A discovery/network failure must not silently fall through to a weaker
    // path — surface it. Detail can carry the issuer URL but no secret.
    console.error("GET /auth/sso/:orgSlug/start error:", (err as Error).message);
    res.redirect(`${FRONTEND_URL}/login?sso_error=start_failed`);
  }
});

// GET /auth/sso/callback — IdP redirect target. Validates the transaction,
// exchanges the code, verifies the ID token, provisions/links, and mints the
// EXISTING Flakey session (JWT + refresh), then bounces to the SPA handoff.
loginRouter.get("/callback", async (req, res) => {
  const tx = readTxCookie(req);
  clearTxCookie(res);
  try {
    // IdP-reported error (user denied, etc.) — surface, don't swallow.
    if (req.query.error) {
      throw new SsoLoginError(`Identity provider returned an error: ${String(req.query.error)}`);
    }
    if (!tx) throw new SsoLoginError("Login session expired or was invalid; please try again");

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) throw new SsoLoginError("Missing authorization code");
    // CSRF/mix-up defence: the state echoed by the IdP must match the one we
    // bound into the transaction cookie.
    if (!state || state !== tx.state) throw new SsoLoginError("State mismatch — possible CSRF");

    const cfg = await loadSsoConfig(tx.org, true);
    if (!cfg || !cfg.enabled || cfg.protocol !== "oidc" || !cfg.oidcIssuer || !cfg.oidcClientId) {
      throw new SsoLoginError("SSO is no longer configured for this organization");
    }

    const tokens = await exchangeCode({
      issuer: cfg.oidcIssuer,
      clientId: cfg.oidcClientId,
      clientSecret: cfg.oidcClientSecret ?? null,
      redirectUri: REDIRECT_URI,
      code,
      codeVerifier: tx.cv,
    });

    const claims = await verifyIdToken({
      issuer: cfg.oidcIssuer,
      clientId: cfg.oidcClientId,
      idToken: tokens.id_token!,
      expectedNonce: tx.nonce,
    });

    const user = await resolveSsoUser(cfg, claims);

    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      orgRole: user.orgRole,
    };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id);
    setTokenCookie(res, token, refreshToken);

    // Hand off to the SPA. The cookies are already set; /sso/complete reads the
    // session into the SPA's localStorage model via GET /auth/sso/session.
    res.redirect(`${FRONTEND_URL}/sso/complete?returnTo=${encodeURIComponent(tx.rt)}`);
  } catch (err) {
    const msg = err instanceof SsoLoginError ? err.message : "Single sign-on failed";
    if (!(err instanceof SsoLoginError)) {
      // Unexpected (network, verification, DB) — log server-side; never echo
      // internals (which can embed tokens/issuer) to the browser.
      console.error("GET /auth/sso/callback error:", (err as Error).message);
    }
    res.redirect(`${FRONTEND_URL}/login?sso_error=${encodeURIComponent(msg)}`);
  }
});

// GET /auth/sso/session — SPA handoff. Reads the httpOnly session cookies the
// callback just set and returns them as JSON so the SPA can populate its
// localStorage auth model, exactly as password login does. Same-origin only
// (CORS allow-list + credentials), so another origin can't read the tokens.
loginRouter.get("/session", async (req, res) => {
  const header = req.headers.cookie;
  const get = (name: string) =>
    header
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${name}=`))
      ?.split("=")
      .slice(1)
      .join("=") ?? null;

  const token = get("flakey_token");
  const refreshToken = get("flakey_refresh");
  if (!token) {
    res.status(401).json({ error: "No SSO session" });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as Record<string, unknown>;
    if (payload.type === "refresh") {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }
    const user = {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      orgId: payload.orgId,
      orgRole: payload.orgRole,
    };
    res.json({ token, refreshToken, user });
  } catch {
    res.status(401).json({ error: "Invalid session token" });
  }
});

// ===========================================================================
// Admin config — mounted at /sso behind requireAuth. Owner/admin only.
// ===========================================================================
const adminRouter = Router();
adminRouter.use(requireSsoEnabled);

function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.orgRole;
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Only organization owners and admins can manage SSO" });
    return;
  }
  next();
}

// GET /sso/config — current org's SSO config. Never returns the client secret;
// only whether one is set.
adminRouter.get("/config", requireOrgAdmin, async (req, res) => {
  try {
    const cfg = await loadSsoConfig(req.user!.orgId, false);
    if (!cfg) {
      res.json({ configured: false });
      return;
    }
    const raw = await loadSsoConfig(req.user!.orgId, true);
    res.json({ configured: true, ...cfg, hasClientSecret: !!raw?.oidcClientSecret });
  } catch (err) {
    console.error("GET /sso/config error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /sso/config — create/update the org's SSO config.
adminRouter.put("/config", requireOrgAdmin, async (req, res) => {
  try {
    const body = req.body ?? {};
    const input: SsoConfigInput = {
      protocol: body.protocol,
      enabled: body.enabled,
      enforced: body.enforced,
      jitProvisioning: body.jitProvisioning,
      allowedDomains: body.allowedDomains,
      defaultRole: body.defaultRole,
      roleClaim: body.roleClaim,
      roleMap: body.roleMap,
      oidcIssuer: body.oidcIssuer,
      oidcClientId: body.oidcClientId,
      oidcClientSecret: body.oidcClientSecret, // undefined → keep existing
    };
    const saved = await saveSsoConfig(req.user!.orgId, input);
    await logAudit(req.user!.orgId, req.user!.id, "auth.sso.config.update", "org", String(req.user!.orgId), {
      protocol: saved.protocol,
      enabled: saved.enabled,
      enforced: saved.enforced,
    });
    const raw = await loadSsoConfig(req.user!.orgId, true);
    res.json({ configured: true, ...saved, hasClientSecret: !!raw?.oidcClientSecret });
  } catch (err) {
    // Validation errors (bad role, etc.) are user-facing; everything else is 500.
    const msg = (err as Error).message ?? "";
    if (/role|domain|must be/i.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    console.error("PUT /sso/config error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { loginRouter as ssoLoginRouter, adminRouter as ssoAdminRouter, SSO_ENABLED };
