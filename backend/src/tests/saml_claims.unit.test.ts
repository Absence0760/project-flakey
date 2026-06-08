/**
 * SAML claims-mapping unit tests — pure logic, no DB, no network.
 *
 * Pins `samlProfileToClaims`: the adapter that turns a node-saml-verified
 * assertion into the same JWTPayload shape `resolveSsoUser()` consumes for
 * OIDC, so provisioning + role mapping are shared across both protocols. This
 * is the SAML half of SSO identity resolution (the OIDC half — mapRole /
 * validateIssuerUrl / PKCE — is pinned in sso.unit.test.ts).
 *
 * Invariants under test:
 *   - email is resolved through the IdP-attribute priority list, then falls
 *     back to an email-shaped NameID, and is normalised (trim + lowercase);
 *   - email_verified is always true (the signed assertion IS the verification);
 *   - sub == NameID; name falls back local-part → NameID;
 *   - multi-valued (array) attributes resolve to their first value;
 *   - the role claim is passed through verbatim so the SAML group attribute
 *     feeds the SAME mapRole containment as OIDC (a forged group can't widen
 *     access beyond role_map).
 *
 * Also pins `assertionHash`: the sha256 one-time-use replay key derived from
 * the verified assertion XML.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import type { Profile } from "@node-saml/node-saml";
import { samlProfileToClaims, assertionHash } from "../sso/saml.js";
import { mapRole, type OrgSsoConfig } from "../sso/config.js";

function cfg(over: Partial<OrgSsoConfig> = {}): OrgSsoConfig {
  return {
    id: 1, orgId: 1, protocol: "saml", enabled: true, enforced: false,
    jitProvisioning: false, allowedDomains: [], defaultRole: "viewer",
    roleClaim: null, roleMap: {}, oidcIssuer: null, oidcClientId: null,
    samlEntryPoint: "https://idp.example.com/sso", samlIdpCert: "x",
    samlIssuer: "flakey-sp", samlAudience: null,
    scimEnabled: false, scimTokenPrefix: null,
    ...over,
  };
}

// node-saml exposes parsed attributes as top-level keys on the profile object
// (saml.js: `profile[name] = value`), so a fixture is just a record with
// nameID + attribute keys. Cast through unknown — we only exercise the keys
// samlProfileToClaims reads.
function profile(over: Record<string, unknown>): Profile {
  return { nameID: "", nameIDFormat: "", issuer: "idp", ...over } as unknown as Profile;
}

// ── email resolution ──────────────────────────────────────────────────────

test("samlProfileToClaims: reads the 'email' attribute", () => {
  const c = samlProfileToClaims(profile({ nameID: "abc-123", email: "user@example.com" }), cfg());
  assert.equal(c.email, "user@example.com");
  assert.equal(c.sub, "abc-123");
});

test("samlProfileToClaims: normalises email (trim + lowercase)", () => {
  const c = samlProfileToClaims(profile({ nameID: "n", email: "  User@Example.COM  " }), cfg());
  assert.equal(c.email, "user@example.com");
});

test("samlProfileToClaims: attribute priority — 'email' wins over 'mail' and the URN/OID", () => {
  const c = samlProfileToClaims(profile({
    nameID: "n",
    email: "primary@example.com",
    mail: "secondary@example.com",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "third@example.com",
    "urn:oid:0.9.2342.19200300.100.1.3": "fourth@example.com",
  }), cfg());
  assert.equal(c.email, "primary@example.com");
});

test("samlProfileToClaims: falls back through 'mail' → schemas URN → OID", () => {
  assert.equal(
    samlProfileToClaims(profile({ nameID: "n", mail: "via-mail@example.com" }), cfg()).email,
    "via-mail@example.com",
  );
  assert.equal(
    samlProfileToClaims(profile({
      nameID: "n",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "via-urn@example.com",
    }), cfg()).email,
    "via-urn@example.com",
  );
  assert.equal(
    samlProfileToClaims(profile({ nameID: "n", "urn:oid:0.9.2342.19200300.100.1.3": "via-oid@example.com" }), cfg()).email,
    "via-oid@example.com",
  );
});

test("samlProfileToClaims: an empty-string attribute is skipped for the next key", () => {
  // A present-but-empty 'email' must not shadow a usable 'mail'.
  const c = samlProfileToClaims(profile({ nameID: "n", email: "", mail: "real@example.com" }), cfg());
  assert.equal(c.email, "real@example.com");
});

test("samlProfileToClaims: a multi-valued attribute resolves to its first value", () => {
  const c = samlProfileToClaims(profile({ nameID: "n", email: ["first@example.com", "second@example.com"] }), cfg());
  assert.equal(c.email, "first@example.com");
});

test("samlProfileToClaims: falls back to an email-shaped NameID when no email attribute", () => {
  const c = samlProfileToClaims(profile({ nameID: "Person@Example.com" }), cfg());
  assert.equal(c.email, "person@example.com");
});

test("samlProfileToClaims: a non-email NameID does NOT become the email (resolveSsoUser then rejects)", () => {
  // Opaque/persistent NameID — there's no usable email, so claims.email is
  // empty and the downstream guard ("did not provide an email address") fires.
  const c = samlProfileToClaims(profile({ nameID: "f47ac10b-58cc-4372-a567-0e02b2c3d479" }), cfg());
  assert.equal(c.email, "");
});

// ── email_verified, sub, name ───────────────────────────────────────────────

test("samlProfileToClaims: email_verified is always true (signed assertion is the verification)", () => {
  const c = samlProfileToClaims(profile({ nameID: "n", email: "u@example.com" }), cfg());
  assert.equal(c.email_verified, true);
});

test("samlProfileToClaims: sub is the NameID", () => {
  const c = samlProfileToClaims(profile({ nameID: "stable-opaque-id", email: "u@example.com" }), cfg());
  assert.equal(c.sub, "stable-opaque-id");
});

test("samlProfileToClaims: non-string NameID yields empty sub", () => {
  const c = samlProfileToClaims(profile({ nameID: undefined as unknown as string, email: "u@example.com" }), cfg());
  assert.equal(c.sub, "");
});

test("samlProfileToClaims: name resolves through displayName/cn/URN/OID priority", () => {
  assert.equal(
    samlProfileToClaims(profile({ nameID: "n", email: "u@example.com", displayName: "Ada Lovelace" }), cfg()).name,
    "Ada Lovelace",
  );
  assert.equal(
    samlProfileToClaims(profile({ nameID: "n", email: "u@example.com", cn: "Grace Hopper" }), cfg()).name,
    "Grace Hopper",
  );
});

test("samlProfileToClaims: name falls back to the email local-part, then to NameID", () => {
  // No name attribute, email present → local-part.
  assert.equal(
    samlProfileToClaims(profile({ nameID: "n", email: "jdoe@example.com" }), cfg()).name,
    "jdoe",
  );
  // No name attribute and no email → NameID.
  assert.equal(
    samlProfileToClaims(profile({ nameID: "opaque-123" }), cfg()).name,
    "opaque-123",
  );
});

// ── role claim passthrough → shared mapRole containment ─────────────────────

test("samlProfileToClaims: no role_claim configured → no extra claim key", () => {
  const c = samlProfileToClaims(profile({ nameID: "n", email: "u@example.com", groups: ["flakey-admin"] }), cfg());
  assert.equal(c.groups, undefined);
});

test("samlProfileToClaims: passes the role attribute through so mapRole resolves it end-to-end", () => {
  const c = cfg({ roleClaim: "groups", roleMap: { "flakey-viewer": "viewer", "flakey-admin": "admin" } });
  // Multi-valued SAML group attribute — node-saml hands it to us as an array.
  const claims = samlProfileToClaims(
    profile({ nameID: "n", email: "u@example.com", groups: ["flakey-viewer", "flakey-admin"] }),
    c,
  );
  assert.deepEqual(claims.groups, ["flakey-viewer", "flakey-admin"]);
  // The SAML group attribute feeds the SAME containment as OIDC: highest of
  // the *mapped* roles wins.
  assert.equal(mapRole(c, claims), "admin");
});

test("samlProfileToClaims: a group with no role_map entry cannot widen access", () => {
  const c = cfg({ roleClaim: "groups", roleMap: { "flakey-viewer": "viewer" } });
  const claims = samlProfileToClaims(
    profile({ nameID: "n", email: "u@example.com", groups: ["domain-admins", "super-root"] }),
    c,
  );
  // Unmapped groups → mapRole null → caller falls back to default_role.
  assert.equal(mapRole(c, claims), null);
});

test("samlProfileToClaims: absent role attribute passes through as undefined (mapRole → null)", () => {
  const c = cfg({ roleClaim: "groups", roleMap: { "flakey-admin": "admin" } });
  const claims = samlProfileToClaims(profile({ nameID: "n", email: "u@example.com" }), c);
  assert.equal(claims.groups, undefined);
  assert.equal(mapRole(c, claims), null);
});

// ── assertionHash (one-time-use replay key) ─────────────────────────────────

function profileWithXml(xml: string): Profile {
  return profile({ nameID: "n", getAssertionXml: () => xml });
}

test("assertionHash: is the sha256 hex of the assertion XML", () => {
  const xml = "<Assertion>...</Assertion>";
  const expected = crypto.createHash("sha256").update(xml).digest("hex");
  assert.equal(assertionHash(profileWithXml(xml)), expected);
});

test("assertionHash: is stable for the same XML and distinct for different XML", () => {
  const a = assertionHash(profileWithXml("<Assertion id='1'/>"));
  const aAgain = assertionHash(profileWithXml("<Assertion id='1'/>"));
  const b = assertionHash(profileWithXml("<Assertion id='2'/>"));
  assert.equal(a, aAgain);
  assert.notEqual(a, b);
});

test("assertionHash: missing getAssertionXml hashes the empty string deterministically", () => {
  const expected = crypto.createHash("sha256").update("").digest("hex");
  assert.equal(assertionHash(profile({ nameID: "n" })), expected);
});
