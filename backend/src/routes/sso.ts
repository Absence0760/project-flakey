import express, { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { signToken, signRefreshToken, setTokenCookie, getJwtSecret } from "../auth.js";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { safeLog } from "../log.js";
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
import {
  buildSamlAuthorizeUrl,
  validateSamlResponse,
  samlProfileToClaims,
  assertionHash,
} from "../sso/saml.js";

// Whole-feature flag (proposal: "each behind a flag"). SSO is OFF unless an
// operator opts in. When off, every SSO route returns a clean 404 so the
// frontend can hide the entry point and nothing half-wires.
const SSO_ENABLED = process.env.FLAKEY_SSO_ENABLED === "true";

const FRONTEND_URL = (process.env.FRONTEND_URL ?? "http://localhost:7778").replace(/\/+$/, "");
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const REDIRECT_URI = `${PUBLIC_API_URL}/auth/sso/callback`;
// SAML POST binding ACS. Unlike OIDC's GET callback, the IdP POSTs here, so the
// OIDC tx cookie (SameSite=lax) wouldn't be sent — we carry the org + state in
// a signed RelayState instead (echoed back by the IdP) and read the pending
// AuthnRequest from an org-scoped DB row.
const SAML_ACS_URL = `${PUBLIC_API_URL}/auth/sso/saml/acs`;
const RELAYSTATE_EXPIRY = "10m";

interface RelayPayload { state: string; org: number; rt: string }

function signRelayState(p: RelayPayload): string {
  return jwt.sign(p, getJwtSecret(), { expiresIn: RELAYSTATE_EXPIRY });
}
function verifyRelayState(raw: unknown): RelayPayload | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return jwt.verify(raw, getJwtSecret(), { algorithms: ["HS256"] }) as RelayPayload;
  } catch {
    return null;
  }
}

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
    // Public endpoint — never echo internals to the caller (the response is a
    // fixed { enabled: false } regardless). Log server-side via safeLog, which
    // CR/LF-strips the message/stack so an attacker-influenced decrypt error
    // can't inject a fake log line (CWE-117).
    console.error("GET /auth/sso/:orgSlug/status error:", safeLog(err));
    res.json({ enabled: false });
  }
});

// GET /auth/sso/:orgSlug/start — begin a login flow (OIDC Auth-Code+PKCE, or
// SAML SP-initiated POST binding), per the org's configured protocol.
loginRouter.get("/:orgSlug/start", async (req, res) => {
  try {
    const orgId = await orgIdBySlug(req.params.orgSlug);
    if (orgId === null) {
      res.status(404).json({ error: "Unknown organization" });
      return;
    }
    const cfg = await loadSsoConfig(orgId, true);
    if (!cfg || !cfg.enabled) {
      res.status(404).json({ error: "SSO is not configured for this organization" });
      return;
    }
    const returnTo = safeReturnPath(req.query.returnTo);

    if (cfg.protocol === "oidc") {
      // Fail closed: OIDC must be fully configured.
      if (!cfg.oidcIssuer || !cfg.oidcClientId) {
        res.status(404).json({ error: "SSO is not configured for this organization" });
        return;
      }
      const { verifier, challenge } = generatePkce();
      const state = randomToken();
      const nonce = randomToken();
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
      return;
    }

    // SAML SP-initiated. The AuthnRequest ID is persisted org-scoped and the
    // org+state ride in a signed RelayState (survives the IdP's POST back).
    if (!cfg.samlEntryPoint || !cfg.samlIdpCert) {
      res.status(404).json({ error: "SSO is not configured for this organization" });
      return;
    }
    const state = randomToken();
    const relay = signRelayState({ state, org: orgId, rt: returnTo });
    const { url, requestId } = await buildSamlAuthorizeUrl(cfg, SAML_ACS_URL, relay);
    await tenantQuery(
      orgId,
      `INSERT INTO sso_saml_requests (org_id, state, request_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
       ON CONFLICT (org_id, state) DO UPDATE SET request_id = EXCLUDED.request_id, expires_at = EXCLUDED.expires_at`,
      [orgId, state, requestId],
    );
    // Opportunistic prune of this org's expired pending requests.
    await tenantQuery(orgId, "DELETE FROM sso_saml_requests WHERE org_id = $1 AND expires_at < NOW()", [orgId]);
    res.redirect(url);
  } catch (err) {
    // A discovery/network/build failure must not silently fall through to a
    // weaker path — surface it. Detail can carry the issuer URL but no secret.
    console.error("GET /auth/sso/:orgSlug/start error:", safeLog(err));
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
    // IdP-reported error (user denied, etc.) — surface, don't swallow. Map the
    // standard OAuth error codes to fixed strings; never reflect an arbitrary
    // attacker-supplied `error` value into the user-facing page (phishing
    // surface — security review finding #5).
    if (req.query.error) {
      const code = String(req.query.error);
      const known: Record<string, string> = {
        access_denied: "Access was denied at your identity provider",
        login_required: "Your identity provider requires you to sign in again",
        interaction_required: "Your identity provider needs additional interaction",
        consent_required: "Consent is required at your identity provider",
        invalid_request: "Your identity provider rejected the request",
        unauthorized_client: "This application is not authorized at your identity provider",
        unsupported_response_type: "Your identity provider rejected the request",
        server_error: "Your identity provider reported an error",
        temporarily_unavailable: "Your identity provider is temporarily unavailable",
      };
      throw new SsoLoginError(known[code] ?? "Your identity provider returned an error");
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

    // ssoOrg records the org this session authenticated against, so it's never
    // clamped for THIS org and a refresh preserves it (but switching into a
    // different enforced org still re-requires SSO).
    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      orgRole: user.orgRole,
      ssoOrg: user.orgId,
    };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id, { ssoOrg: user.orgId });
    setTokenCookie(res, token, refreshToken);

    // Hand off to the SPA. The cookies are already set; /sso/complete reads the
    // session into the SPA's localStorage model via GET /auth/sso/session.
    res.redirect(`${FRONTEND_URL}/sso/complete?returnTo=${encodeURIComponent(tx.rt)}`);
  } catch (err) {
    const msg = err instanceof SsoLoginError ? err.message : "Single sign-on failed";
    if (!(err instanceof SsoLoginError)) {
      // Unexpected (network, verification, DB) — log server-side; never echo
      // internals (which can embed tokens/issuer) to the browser.
      console.error("GET /auth/sso/callback error:", safeLog(err));
    }
    res.redirect(`${FRONTEND_URL}/login?sso_error=${encodeURIComponent(msg)}`);
  }
});

// POST /auth/sso/saml/acs — SAML Assertion Consumer Service (POST binding).
// The IdP POSTs SAMLResponse + RelayState (form-encoded). node-saml validates
// the signature, conditions (NotBefore/NotOnOrAfter + skew), and audience; we
// add InResponseTo binding + one-time assertion use, then mint the existing
// Flakey session. express.urlencoded is route-local (the app is JSON globally).
loginRouter.post("/saml/acs", express.urlencoded({ extended: false, limit: "1mb" }), async (req, res) => {
  const relay = verifyRelayState(req.body?.RelayState);
  try {
    if (req.body?.SAMLResponse == null) throw new SsoLoginError("Missing SAML response");
    if (!relay) throw new SsoLoginError("Login session expired or was invalid; please try again");

    const cfg = await loadSsoConfig(relay.org, true);
    if (!cfg || !cfg.enabled || cfg.protocol !== "saml" || !cfg.samlEntryPoint || !cfg.samlIdpCert) {
      throw new SsoLoginError("SAML SSO is no longer configured for this organization");
    }

    // Signature + conditions + audience are validated here (throws on failure).
    const profile = await validateSamlResponse(cfg, SAML_ACS_URL, {
      SAMLResponse: req.body.SAMLResponse,
      RelayState: req.body.RelayState,
    });

    // InResponseTo binding: consume the pending AuthnRequest exactly once.
    const consumed = await tenantQuery(
      relay.org,
      "DELETE FROM sso_saml_requests WHERE org_id = $1 AND state = $2 AND expires_at > NOW() RETURNING request_id",
      [relay.org, relay.state],
    );
    const requestId = consumed.rows[0]?.request_id;
    if (!requestId) throw new SsoLoginError("Unknown or expired login request");
    const inResponseTo = typeof profile.inResponseTo === "string" ? profile.inResponseTo : null;
    if (!inResponseTo || inResponseTo !== requestId) {
      throw new SsoLoginError("SAML InResponseTo mismatch — possible replay");
    }

    // One-time assertion use: a replayed assertion collides on the hash.
    const hash = assertionHash(profile);
    const ins = await tenantQuery(
      relay.org,
      `INSERT INTO sso_saml_replay (org_id, assertion_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour') ON CONFLICT (org_id, assertion_hash) DO NOTHING`,
      [relay.org, hash],
    );
    if (!ins.rowCount) throw new SsoLoginError("This SAML assertion has already been used");
    await tenantQuery(relay.org, "DELETE FROM sso_saml_replay WHERE org_id = $1 AND expires_at < NOW()", [relay.org]);

    const user = await resolveSsoUser(cfg, samlProfileToClaims(profile, cfg));
    const authUser = {
      id: user.id, email: user.email, name: user.name,
      role: user.role, orgId: user.orgId, orgRole: user.orgRole, ssoOrg: user.orgId,
    };
    const token = signToken(authUser);
    const refreshToken = signRefreshToken(user.id, { ssoOrg: user.orgId });
    setTokenCookie(res, token, refreshToken);
    res.redirect(`${FRONTEND_URL}/sso/complete?returnTo=${encodeURIComponent(relay.rt)}`);
  } catch (err) {
    const msg = err instanceof SsoLoginError ? err.message : "Single sign-on failed";
    if (!(err instanceof SsoLoginError)) {
      console.error("POST /auth/sso/saml/acs error:", safeLog(err));
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

// The exact validation messages saveSsoConfig()/validateIssuerUrl() throw
// (backend/src/sso/config.ts). Membership in this set is what makes an error
// safe to echo back to the admin — anything else is treated as internal and
// hidden behind a fixed 500. Keep this in lockstep with config.ts.
const USER_FACING_CONFIG_ERRORS = new Set<string>([
  "OIDC issuer must be a valid URL",
  "OIDC issuer must use https",
  "OIDC issuer must not be a loopback address",
  "OIDC issuer must not resolve to a private/loopback network address",
  "default_role must be one of owner, admin, viewer",
]);
// The role_map message embeds the caller-supplied bad value, so it can't be an
// exact-match member; recognise it by its stable prefix instead (the suffix is
// the admin's own input being reflected back to them).
const ROLE_MAP_ERROR_PREFIX = "role_map values must be one of ";

function isUserFacingConfigError(msg: string): boolean {
  return USER_FACING_CONFIG_ERRORS.has(msg) || msg.startsWith(ROLE_MAP_ERROR_PREFIX);
}

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
    console.error("GET /sso/config error:", safeLog(err));
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
      samlEntryPoint: body.samlEntryPoint,
      samlIdpCert: body.samlIdpCert,
      samlIssuer: body.samlIssuer,
      samlAudience: body.samlAudience,
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
    // Validation errors are user-facing; everything else is 500. Match against
    // an explicit allow-list of the messages saveSsoConfig()/validateIssuerUrl()
    // throw (sso/config.ts) rather than a regex — a deeper layer (DB/library)
    // could otherwise match a loose pattern and leak internals to the client.
    const msg = (err as Error).message ?? "";
    if (isUserFacingConfigError(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    console.error("PUT /sso/config error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /sso/scim/token — issue (or rotate) the org's SCIM bearer token and
// enable SCIM. Returns the raw token ONCE (only its bcrypt hash is stored).
adminRouter.post("/scim/token", requireOrgAdmin, async (req, res) => {
  try {
    const { issueScimToken } = await import("../sso/scim.js");
    const { token, prefix } = await issueScimToken(req.user!.orgId);
    res.status(201).json({
      token, // shown once — the IdP stores it; we keep only the hash
      prefix,
      scimBaseUrl: `${PUBLIC_API_URL}/scim/v2`,
    });
  } catch (err) {
    console.error("POST /sso/scim/token error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /sso/scim/token — disable SCIM + clear the token.
adminRouter.delete("/scim/token", requireOrgAdmin, async (req, res) => {
  try {
    const { disableScim } = await import("../sso/scim.js");
    await disableScim(req.user!.orgId);
    res.json({ disabled: true });
  } catch (err) {
    console.error("DELETE /sso/scim/token error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

export { loginRouter as ssoLoginRouter, adminRouter as ssoAdminRouter, SSO_ENABLED };
