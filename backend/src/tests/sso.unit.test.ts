/**
 * SSO unit tests — pure logic, no DB.
 *
 * Pins the security-critical role-mapping contract (proposal trust boundary
 * #1: a forged/over-scoped IdP claim can never exceed the admin-configured
 * role_map) and the PKCE/state primitives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRole, type OrgSsoConfig } from "../sso/config.js";
import { generatePkce, randomToken } from "../sso/oidc.js";
import crypto from "crypto";

function cfg(over: Partial<OrgSsoConfig>): OrgSsoConfig {
  return {
    id: 1, orgId: 1, protocol: "oidc", enabled: true, enforced: false,
    jitProvisioning: false, allowedDomains: [], defaultRole: "viewer",
    roleClaim: null, roleMap: {}, oidcIssuer: null, oidcClientId: null,
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
