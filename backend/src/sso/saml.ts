// SAML 2.0 SP primitives for enterprise SSO login — a thin, security-focused
// wrapper around the vetted @node-saml/node-saml library. We do NOT hand-roll
// XML signature handling (proposal Slice 2: "use a vetted library; do not
// hand-roll" — XML signature wrapping / canonicalization is the danger zone).
//
// What node-saml enforces for us on validatePostResponseAsync:
//   - the assertion signature against the configured IdP cert (wantAssertionsSigned),
//   - the assertion conditions: NotBefore / NotOnOrAfter (+ clock skew), audience,
//   - rejects unsigned / alg-stripped assertions.
// What THIS app adds on top (in routes/sso.ts):
//   - InResponseTo binding to the AuthnRequest we issued (org-scoped DB row),
//   - one-time assertion use (assertion-hash replay table),
//   - the same provisioning / role-mapping containment as OIDC.

import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import crypto from "crypto";
import type { JWTPayload } from "jose";
import { normalizeEmail } from "../auth.js";
import type { OrgSsoConfig } from "./config.js";

// node-saml accepts a bare base64 cert body or full PEM; normalise to the bare
// base64 body so either form an admin pastes works.
function normalizeCert(cert: string): string {
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function makeSaml(
  config: OrgSsoConfig,
  callbackUrl: string,
  generateUniqueId?: () => string,
): SAML {
  if (!config.samlEntryPoint || !config.samlIdpCert) {
    throw new Error("SAML config is incomplete (entry point / IdP cert)");
  }
  const spEntityId = config.samlIssuer || callbackUrl;
  return new SAML({
    callbackUrl,
    entryPoint: config.samlEntryPoint,
    issuer: spEntityId,
    idpCert: normalizeCert(config.samlIdpCert),
    // Bind the assertion to us. `false` would disable audience checking — we
    // never want that; default to the SP entityID.
    audience: config.samlAudience || spEntityId,
    // Require the ASSERTION (which carries identity) to be signed. We don't
    // additionally require the response envelope to be signed, so IdPs that
    // sign only the assertion (common, e.g. Keycloak defaults) interoperate
    // while the identity-bearing element is still cryptographically verified.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5000,
    maxAssertionAgeMs: 60 * 60 * 1000,
    // We perform our own org-scoped InResponseTo check (node-saml's cache is
    // process-local and not multi-task safe), so disable its built-in check.
    validateInResponseTo: ValidateInResponseTo.never,
    identifierFormat: null,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    ...(generateUniqueId ? { generateUniqueId } : {}),
  });
}

export interface SamlAuthorizeResult {
  url: string;
  requestId: string;
}

/**
 * Build the IdP SSO redirect URL for an SP-initiated AuthnRequest. Captures the
 * generated AuthnRequest ID so the caller can persist it and validate the
 * InResponseTo on the assertion that comes back.
 */
export async function buildSamlAuthorizeUrl(
  config: OrgSsoConfig,
  callbackUrl: string,
  relayState: string,
): Promise<SamlAuthorizeResult> {
  const ids: string[] = [];
  const gen = () => {
    // SAML IDs must be valid XML NCNames — start with a letter/underscore.
    const id = "_" + crypto.randomBytes(21).toString("hex");
    ids.push(id);
    return id;
  };
  const saml = makeSaml(config, callbackUrl, gen);
  const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
  if (ids.length === 0) throw new Error("Failed to capture AuthnRequest ID");
  return { url, requestId: ids[0] };
}

/**
 * Validate a SAML POST response. Throws on any signature / condition /
 * audience failure (node-saml). Returns the verified profile.
 */
export async function validateSamlResponse(
  config: OrgSsoConfig,
  callbackUrl: string,
  body: Record<string, string>,
): Promise<Profile> {
  const saml = makeSaml(config, callbackUrl);
  const { profile } = await saml.validatePostResponseAsync(body);
  if (!profile) throw new Error("SAML response did not yield a profile");
  return profile;
}

/** sha256 of the validated assertion XML — the one-time-use replay key. */
export function assertionHash(profile: Profile): string {
  const xml = profile.getAssertionXml?.() ?? "";
  return crypto.createHash("sha256").update(xml).digest("hex");
}

// Common attribute names IdPs use for email / display name, in priority order.
const EMAIL_ATTRS = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_ATTRS = [
  "displayName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "cn",
  "urn:oid:2.16.840.1.113730.3.1.241",
];

function firstString(profile: Profile, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = profile[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0]) return v[0];
  }
  return undefined;
}

/**
 * Adapt a verified SAML profile into the same claims shape resolveSsoUser()
 * consumes for OIDC, so provisioning + role mapping are shared.
 *
 * email_verified is set true: a SAML assertion is signed by the IdP, which is
 * the verification — the SP doesn't receive an explicit email_verified flag.
 */
export function samlProfileToClaims(profile: Profile, config: OrgSsoConfig): JWTPayload {
  const nameId = typeof profile.nameID === "string" ? profile.nameID : "";
  let email = firstString(profile, EMAIL_ATTRS);
  if (!email && nameId.includes("@")) email = nameId; // emailAddress NameID
  const claims: JWTPayload = {
    sub: nameId,
    email: normalizeEmail(email),
    email_verified: true,
    name: firstString(profile, NAME_ATTRS) ?? (email ? email.split("@")[0] : nameId),
  };
  if (config.roleClaim) {
    claims[config.roleClaim] = profile[config.roleClaim] as unknown;
  }
  return claims;
}
