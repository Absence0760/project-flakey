// Org SSO configuration + the JIT/link provisioning logic that maps a verified
// IdP identity onto the existing Flakey user/org model.
//
// Containment principle (proposal trust boundary #1): SSO mints the SAME
// session the app already issues. Nothing here grants access on its own — org
// access is still an org_members row + RLS. A forged or over-scoped IdP claim
// can only reach a role the org admin explicitly placed in role_map; an
// unmapped value falls back to default_role and never widens access.

import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { JWTPayload } from "jose";
import pool, { tenantQuery } from "../db.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { normalizeEmail } from "../auth.js";
import { logAudit } from "../audit.js";

export type OrgRole = "owner" | "admin" | "viewer";
const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "viewer"];
// Privilege order, lowest → highest. When an IdP role claim carries several
// values that map to Flakey roles, the highest-privilege mapping wins.
const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, admin: 1, owner: 2 };

export interface OrgSsoConfig {
  id: number;
  orgId: number;
  protocol: "oidc" | "saml";
  enabled: boolean;
  enforced: boolean;
  jitProvisioning: boolean;
  allowedDomains: string[];
  defaultRole: OrgRole;
  roleClaim: string | null;
  roleMap: Record<string, string>;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  // Present only on the internal (decrypted) load used by the login flow;
  // never returned to API callers.
  oidcClientSecret?: string | null;
  // SAML (Slice 2). The IdP signing cert is a public cert — stored plaintext.
  samlEntryPoint: string | null;
  samlIdpCert: string | null;
  samlIssuer: string | null;
  samlAudience: string | null;
  // SCIM (Slice 3). The token hash is never surfaced; only whether it's enabled
  // and the non-secret prefix.
  scimEnabled: boolean;
  scimTokenPrefix: string | null;
}

interface SsoConfigRow {
  id: number;
  org_id: number;
  protocol: "oidc" | "saml";
  enabled: boolean;
  enforced: boolean;
  jit_provisioning: boolean;
  allowed_domains: string[];
  default_role: OrgRole;
  role_claim: string | null;
  role_map: Record<string, string>;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret: string | null;
  saml_entry_point: string | null;
  saml_idp_cert: string | null;
  saml_issuer: string | null;
  saml_audience: string | null;
  scim_enabled: boolean;
  scim_token_prefix: string | null;
}

function rowToConfig(r: SsoConfigRow, includeSecret: boolean): OrgSsoConfig {
  const cfg: OrgSsoConfig = {
    id: r.id,
    orgId: r.org_id,
    protocol: r.protocol,
    enabled: r.enabled,
    enforced: r.enforced,
    jitProvisioning: r.jit_provisioning,
    allowedDomains: r.allowed_domains ?? [],
    defaultRole: r.default_role,
    roleClaim: r.role_claim,
    roleMap: r.role_map ?? {},
    oidcIssuer: r.oidc_issuer,
    oidcClientId: r.oidc_client_id,
    samlEntryPoint: r.saml_entry_point,
    samlIdpCert: r.saml_idp_cert,
    samlIssuer: r.saml_issuer,
    samlAudience: r.saml_audience,
    scimEnabled: r.scim_enabled ?? false,
    scimTokenPrefix: r.scim_token_prefix,
  };
  if (includeSecret) cfg.oidcClientSecret = decryptSecret(r.oidc_client_secret);
  return cfg;
}

/** Resolve an org id from its public slug. Pre-auth safe (no org context). */
export async function orgIdBySlug(slug: string): Promise<number | null> {
  const r = await pool.query("SELECT id FROM organizations WHERE slug = $1", [slug]);
  return r.rows[0]?.id ?? null;
}

/**
 * Load an org's SSO config. `includeSecret` decrypts the client secret for the
 * login flow; admin reads pass false so the secret never leaves the server.
 * Routed through tenantQuery so the org_sso_configs RLS policy admits the read.
 */
export async function loadSsoConfig(
  orgId: number,
  includeSecret = false,
): Promise<OrgSsoConfig | null> {
  const r = await tenantQuery(
    orgId,
    "SELECT * FROM org_sso_configs WHERE org_id = $1",
    [orgId],
  );
  if (r.rows.length === 0) return null;
  return rowToConfig(r.rows[0] as SsoConfigRow, includeSecret);
}

export interface SsoConfigInput {
  protocol?: "oidc" | "saml";
  enabled?: boolean;
  enforced?: boolean;
  jitProvisioning?: boolean;
  allowedDomains?: string[];
  defaultRole?: OrgRole;
  roleClaim?: string | null;
  roleMap?: Record<string, string>;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  // A new plaintext secret to encrypt. `undefined` leaves the stored secret
  // untouched (so a config PATCH that omits it doesn't wipe it); `null`/"" clears it.
  oidcClientSecret?: string | null;
  samlEntryPoint?: string | null;
  samlIdpCert?: string | null;
  samlIssuer?: string | null;
  samlAudience?: string | null;
}

// Reject obviously-internal OIDC issuer URLs at save time. The issuer is
// admin-configured but the backend fetches it server-side (discovery), so a
// malicious/compromised admin could point it at cloud metadata or an internal
// service (SSRF — security review finding #3). This blocks the easy IP-literal
// cases; loopback is allowed only outside production (local Keycloak dev). It
// is NOT a complete SSRF defence — a hostname that DNS-resolves to a private IP
// still slips through; that residual risk is documented for the CISO.
export function validateIssuerUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("OIDC issuer must be a valid URL"); }
  const isProd = process.env.NODE_ENV === "production";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !isProd)) {
    throw new Error("OIDC issuer must use https");
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (loopback) {
    if (isProd) throw new Error("OIDC issuer must not be a loopback address");
    return; // dev: allow local Keycloak
  }
  // Block IPv4 literals in private / link-local / metadata ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (isPrivate) throw new Error("OIDC issuer must not resolve to a private network address");
  }
  // Block IPv6 literal loopback / unique-local / link-local.
  if (host.includes(":") && (/^f[cd]/.test(host) || /^fe80/.test(host))) {
    throw new Error("OIDC issuer must not be a private IPv6 address");
  }
}

/** Validate + upsert an org's SSO config, encrypting the client secret. */
export async function saveSsoConfig(
  orgId: number,
  input: SsoConfigInput,
): Promise<OrgSsoConfig> {
  if (input.oidcIssuer) validateIssuerUrl(input.oidcIssuer);
  if (input.defaultRole && !ORG_ROLES.includes(input.defaultRole)) {
    throw new Error("default_role must be one of owner, admin, viewer");
  }
  if (input.roleMap) {
    for (const v of Object.values(input.roleMap)) {
      if (!ORG_ROLES.includes(v as OrgRole)) {
        throw new Error(`role_map values must be one of ${ORG_ROLES.join(", ")} (got "${v}")`);
      }
    }
  }
  const domains = (input.allowedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);

  // Upsert in one statement. COALESCE preserves the stored secret when the
  // caller omits oidcClientSecret (undefined → not in the params → keep).
  const existing = await loadSsoConfig(orgId, false);
  const encSecret =
    input.oidcClientSecret === undefined
      ? undefined
      : encryptSecret(input.oidcClientSecret ?? "");

  await tenantQuery(
    orgId,
    `INSERT INTO org_sso_configs
       (org_id, protocol, enabled, enforced, jit_provisioning, allowed_domains,
        default_role, role_claim, role_map, oidc_issuer, oidc_client_id, oidc_client_secret,
        saml_entry_point, saml_idp_cert, saml_issuer, saml_audience)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (org_id) DO UPDATE SET
       protocol           = EXCLUDED.protocol,
       enabled            = EXCLUDED.enabled,
       enforced           = EXCLUDED.enforced,
       jit_provisioning   = EXCLUDED.jit_provisioning,
       allowed_domains    = EXCLUDED.allowed_domains,
       default_role       = EXCLUDED.default_role,
       role_claim         = EXCLUDED.role_claim,
       role_map           = EXCLUDED.role_map,
       oidc_issuer        = EXCLUDED.oidc_issuer,
       oidc_client_id     = EXCLUDED.oidc_client_id,
       -- Keep the existing secret when the caller didn't send a new one.
       -- EXCLUDED.oidc_client_secret is the value we tried to insert ($12):
       -- null when the caller omitted it, so COALESCE preserves the stored one.
       oidc_client_secret = COALESCE(EXCLUDED.oidc_client_secret, org_sso_configs.oidc_client_secret),
       saml_entry_point   = EXCLUDED.saml_entry_point,
       saml_idp_cert      = EXCLUDED.saml_idp_cert,
       saml_issuer        = EXCLUDED.saml_issuer,
       saml_audience      = EXCLUDED.saml_audience,
       updated_at         = NOW()`,
    [
      orgId,
      input.protocol ?? existing?.protocol ?? "oidc",
      input.enabled ?? existing?.enabled ?? false,
      input.enforced ?? existing?.enforced ?? false,
      input.jitProvisioning ?? existing?.jitProvisioning ?? false,
      domains.length ? domains : existing?.allowedDomains ?? [],
      input.defaultRole ?? existing?.defaultRole ?? "viewer",
      input.roleClaim === undefined ? existing?.roleClaim ?? null : input.roleClaim,
      JSON.stringify(input.roleMap ?? existing?.roleMap ?? {}),
      input.oidcIssuer === undefined ? existing?.oidcIssuer ?? null : input.oidcIssuer,
      input.oidcClientId === undefined ? existing?.oidcClientId ?? null : input.oidcClientId,
      // $12: new encrypted secret, or null. On conflict, null flows through
      // EXCLUDED into COALESCE and preserves the stored secret.
      encSecret ?? null,
      input.samlEntryPoint === undefined ? existing?.samlEntryPoint ?? null : input.samlEntryPoint,
      input.samlIdpCert === undefined ? existing?.samlIdpCert ?? null : input.samlIdpCert,
      input.samlIssuer === undefined ? existing?.samlIssuer ?? null : input.samlIssuer,
      input.samlAudience === undefined ? existing?.samlAudience ?? null : input.samlAudience,
    ],
  );

  const saved = await loadSsoConfig(orgId, false);
  if (!saved) throw new Error("SSO config save failed");
  return saved;
}

/**
 * Map an IdP role claim onto a Flakey org role using the admin-configured
 * role_map. Returns the highest-privilege mapped role, or null when no claim
 * value maps (caller falls back to default_role). A claim value not present
 * in role_map is ignored — it can never widen access.
 */
export function mapRole(config: OrgSsoConfig, claims: JWTPayload): OrgRole | null {
  if (!config.roleClaim) return null;
  const raw = (claims as Record<string, unknown>)[config.roleClaim];
  const values: string[] = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? [raw]
      : [];
  let best: OrgRole | null = null;
  for (const v of values) {
    const mapped = config.roleMap[v] as OrgRole | undefined;
    if (mapped && ORG_ROLES.includes(mapped)) {
      if (best === null || ROLE_RANK[mapped] > ROLE_RANK[best]) best = mapped;
    }
  }
  return best;
}

/** A login the provisioning layer refuses, with a user-safe message. */
export class SsoLoginError extends Error {}

export interface ResolvedSsoUser {
  id: number;
  email: string;
  name: string;
  role: string; // global users.role
  orgId: number;
  orgRole: OrgRole;
}

/**
 * Resolve a verified IdP identity to a Flakey user + org membership, JIT-
 * provisioning or linking per the org's policy. Throws SsoLoginError (fail
 * closed) when the login isn't permitted. The caller mints the existing Flakey
 * JWT from the returned identity — no new session primitive.
 */
export async function resolveSsoUser(
  config: OrgSsoConfig,
  claims: JWTPayload,
): Promise<ResolvedSsoUser> {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = normalizeEmail(claims.email as string | undefined);
  if (!sub) throw new SsoLoginError("IdP token is missing a subject");
  if (!email) throw new SsoLoginError("IdP token did not provide an email address");

  // Require a verified email before we will link or create an account. This is
  // the proposal's account-linking guard (open-question default): an SSO login
  // can only attach to / create an account when the IdP attests the email.
  if (claims.email_verified !== true) {
    throw new SsoLoginError("Your identity provider has not verified this email address");
  }

  // Domain restriction (when configured).
  if (config.allowedDomains.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!config.allowedDomains.includes(domain)) {
      throw new SsoLoginError("This email domain is not permitted to sign in to this organization");
    }
  }

  const mappedRole = mapRole(config, claims);
  const name = typeof claims.name === "string" ? claims.name : email.split("@")[0];

  // 1. Existing SSO identity for this (org, protocol, sub)?
  const identityRes = await tenantQuery(
    config.orgId,
    "SELECT user_id FROM sso_identities WHERE org_id = $1 AND protocol = $2 AND external_id = $3",
    [config.orgId, config.protocol, sub],
  );

  let userId: number | null = identityRes.rows[0]?.user_id ?? null;
  let isNewUser = false;

  if (userId === null) {
    // 2. No identity yet — find an existing user by verified email to link, or
    //    JIT-create one if the org allows it.
    const userRes = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
    } else {
      if (!config.jitProvisioning) {
        throw new SsoLoginError(
          "No Flakey account exists for this email. Ask an organization admin to invite you.",
        );
      }
      // Create the user with an unusable random password (SSO is the only
      // credential). email_verified=true because the IdP attested it above.
      const randomPw = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12);
      const created = await pool.query(
        `INSERT INTO users (email, password_hash, name, email_verified)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [email, randomPw, name],
      );
      userId = created.rows[0].id;
      isNewUser = true;
    }
    // Record the identity so subsequent logins resolve deterministically.
    await tenantQuery(
      config.orgId,
      `INSERT INTO sso_identities (org_id, user_id, protocol, external_id, last_login_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (org_id, protocol, external_id) DO UPDATE SET last_login_at = NOW()`,
      [config.orgId, userId, config.protocol, sub],
    );
  } else {
    await tenantQuery(
      config.orgId,
      "UPDATE sso_identities SET last_login_at = NOW() WHERE org_id = $1 AND protocol = $2 AND external_id = $3",
      [config.orgId, config.protocol, sub],
    );
  }

  // 3. Ensure org membership. org_members carries no RLS (auth paths read it
  //    via pool.query), matching resolveOrg() in routes/auth.ts.
  const memberRes = await pool.query(
    "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
    [config.orgId, userId],
  );

  let orgRole: OrgRole;
  if (memberRes.rows.length === 0) {
    // Not a member. Only auto-join when JIT is enabled; otherwise the user has
    // an account but no business in this org — refuse.
    if (!config.jitProvisioning) {
      throw new SsoLoginError(
        "Your account is not a member of this organization. Ask an admin to invite you.",
      );
    }
    orgRole = mappedRole ?? config.defaultRole;
    await pool.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING",
      [config.orgId, userId, orgRole],
    );
  } else {
    orgRole = memberRes.rows[0].role;
    // When the org has the IdP govern roles (role_claim configured) and the
    // claim maps to a role, sync the membership to it so an IdP-side change
    // takes effect. Stays within role_map — cannot exceed admin config.
    if (config.roleClaim && mappedRole && mappedRole !== orgRole) {
      await pool.query(
        "UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3",
        [mappedRole, config.orgId, userId],
      );
      orgRole = mappedRole;
    }
  }

  const finalUser = await pool.query(
    "SELECT id, email, name, role FROM users WHERE id = $1",
    [userId],
  );
  const u = finalUser.rows[0];

  await logAudit(
    config.orgId,
    u.id,
    isNewUser ? "auth.sso.provision" : "auth.sso.login",
    "user",
    String(u.id),
    { protocol: config.protocol, email: u.email, orgRole, jit: isNewUser },
  );

  return { id: u.id, email: u.email, name: u.name, role: u.role, orgId: config.orgId, orgRole };
}
