/**
 * SSO unit tests — pure logic, no DB.
 *
 * Pins the security-critical role-mapping contract (proposal trust boundary
 * #1: a forged/over-scoped IdP claim can never exceed the admin-configured
 * role_map) and the PKCE/state primitives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRole, validateIssuerUrl, type OrgSsoConfig } from "../sso/config.js";
import { generatePkce, randomToken, assertPublicHost } from "../sso/oidc.js";
import { isSsoEnforcementBypassed } from "../auth.js";
import crypto from "crypto";

function cfg(over: Partial<OrgSsoConfig>): OrgSsoConfig {
  return {
    id: 1, orgId: 1, protocol: "oidc", enabled: true, enforced: false,
    jitProvisioning: false, allowedDomains: [], defaultRole: "viewer",
    roleClaim: null, roleMap: {}, oidcIssuer: null, oidcClientId: null,
    samlEntryPoint: null, samlIdpCert: null, samlIssuer: null, samlAudience: null,
    scimEnabled: false, scimTokenPrefix: null,
    ...over,
  };
}

test("mapRole returns null when no role_claim is configured", () => {
  assert.equal(mapRole(cfg({ roleMap: { "x": "admin" } }), { flakey_roles: ["x"] }), null);
});

test("mapRole maps a single string claim value", () => {
  const c = cfg({ roleClaim: "flakey_roles", roleMap: { "flakey-viewer": "viewer" } });
  assert.equal(mapRole(c, { flakey_roles: "flakey-viewer" }), "viewer");
});

test("mapRole maps an array claim and picks the highest-privilege role", () => {
  const c = cfg({ roleClaim: "flakey_roles", roleMap: { "fa": "admin", "fv": "viewer", "fo": "owner" } });
  assert.equal(mapRole(c, { flakey_roles: ["fv", "fa"] }), "admin");
  assert.equal(mapRole(c, { flakey_roles: ["fv", "fo", "fa"] }), "owner");
});

test("mapRole ignores claim values not present in role_map (cannot widen access)", () => {
  const c = cfg({ roleClaim: "flakey_roles", roleMap: { "flakey-viewer": "viewer" } });
  // An attacker-supplied 'super-admin' claim with no mapping yields null →
  // caller falls back to default_role, never escalates.
  assert.equal(mapRole(c, { flakey_roles: ["super-admin", "owner", "root"] }), null);
});

test("mapRole returns null when the claim is absent", () => {
  const c = cfg({ roleClaim: "flakey_roles", roleMap: { "x": "admin" } });
  assert.equal(mapRole(c, { email: "a@b.com" }), null);
});

test("generatePkce produces a verifier and a matching S256 challenge", () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43, "verifier must meet RFC 7636 minimum length");
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.ok(!/[+/=]/.test(challenge), "challenge must be base64url (no +, /, =)");
});

test("randomToken yields unique, URL-safe values", () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.ok(!/[+/=]/.test(a) && !/[+/=]/.test(b));
});

test("validateIssuerUrl blocks SSRF-prone issuer URLs (private/metadata/non-https)", () => {
  // Private + metadata IP literals are rejected in every environment.
  assert.throws(() => validateIssuerUrl("https://169.254.169.254/"), /private/i, "cloud metadata IP");
  assert.throws(() => validateIssuerUrl("https://10.0.0.5/realms/x"), /private/i, "10.x");
  assert.throws(() => validateIssuerUrl("https://192.168.1.10/"), /private/i, "192.168.x");
  assert.throws(() => validateIssuerUrl("https://172.16.4.4/"), /private/i, "172.16-31");
  assert.throws(() => validateIssuerUrl("ftp://idp.example.com/"), /https/i, "non-http scheme");
  assert.throws(() => validateIssuerUrl("not a url"), /valid URL/i);
  // IPv4-mapped IPv6 literal of the metadata IP must also be blocked at save time.
  assert.throws(() => validateIssuerUrl("https://[::ffff:169.254.169.254]/"), /private|loopback/i, "IPv4-mapped IPv6 metadata");
  // A normal external https issuer is fine.
  assert.doesNotThrow(() => validateIssuerUrl("https://idp.example.com/realms/acme"));
});

test("assertPublicHost blocks private/metadata IPs at fetch time (IP literals)", async () => {
  await assert.rejects(() => assertPublicHost("https://169.254.169.254/.well-known/openid-configuration"), /non-public/i);
  await assert.rejects(() => assertPublicHost("https://10.1.2.3/"), /non-public/i);
  await assert.rejects(() => assertPublicHost("https://192.168.0.1/"), /non-public/i);
  // A public IP literal is allowed.
  await assert.doesNotReject(() => assertPublicHost("https://8.8.8.8/"));
  // Loopback is allowed outside production (NODE_ENV is not 'production' here),
  // so the local mock-IdP / Keycloak dev flow keeps working.
  await assert.doesNotReject(() => assertPublicHost("http://127.0.0.1:8081/"));
});

test("SSO enforcement break-glass: seeded admin is exempt in dev, others are not", () => {
  // Default outside production includes the seeded admin so local dev (and
  // emergency access) never gets forced through an IdP. Case-insensitive.
  assert.equal(isSsoEnforcementBypassed("admin@example.com"), true);
  assert.equal(isSsoEnforcementBypassed("Admin@Example.com"), true);
  assert.equal(isSsoEnforcementBypassed("someone.else@example.com"), false);
  assert.equal(isSsoEnforcementBypassed(null), false);
});
