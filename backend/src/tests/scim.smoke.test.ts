/**
 * SCIM 2.0 provisioning smoke tests — full app, real DB.
 *
 * Validates the Authentik->target contract (infra/scim-target/server.mjs) plus
 * the proposal's key GovRAMP control (Slice 3 / trust boundary #5):
 * deactivation removes the org membership so access is revoked immediately.
 * Also proves per-org RLS isolation of SCIM resources.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3993;
const BASE = `http://localhost:${PORT}`;
const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow — test fixture

let server: ChildProcess;
let db: pg.Pool;
// Org 1 (primary) and Org 2 (isolation check).
let scimToken1 = "", orgId1 = 0;
let scimToken2 = "", orgId2 = 0;

function waitForHealth(maxMs = 10000): Promise<void> {
  return (async () => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Backend did not become healthy in time");
  })();
}

async function registerOrgAndIssueToken(): Promise<{ token: string; orgId: number }> {
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `scim+${Date.now()}.${Math.floor(performance.now())}@test.local`, password: "testpass123", name: "SCIM Admin" }),
  });
  const jwt = ((await reg.json()) as { token: string }).token;
  const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${jwt}` } });
  const orgId = ((await me.json()) as { orgs: { id: number }[] }).orgs[0].id;
  const tok = await fetch(`${BASE}/sso/scim/token`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(tok.status, 201, "issuing a SCIM token should succeed");
  const token = ((await tok.json()) as { token: string }).token;
  return { token, orgId };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env, PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app", DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "scim-smoke-secret", FLAKEY_ENCRYPTION_KEY: ENC_KEY,
      ALLOW_REGISTRATION: "true", NODE_ENV: "test", FLAKEY_SSO_ENABLED: "true",
      PUBLIC_API_URL: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
  db = new pg.Pool({
    host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey_app", password: "flakey_app", database: process.env.DB_NAME ?? "flakey",
  });
  ({ token: scimToken1, orgId: orgId1 } = await registerOrgAndIssueToken());
  ({ token: scimToken2, orgId: orgId2 } = await registerOrgAndIssueToken());
});

after(async () => {
  await db?.end().catch(() => {});
  if (server && !server.killed) { server.kill("SIGTERM"); await once(server, "exit").catch(() => {}); }
});

// org_members + users carry no RLS (auth paths read them directly), so this
// reads the live membership to assert the provisioning effect.
async function membershipRole(orgId: number, email: string): Promise<string | null> {
  const r = await db.query(
    "SELECT om.role FROM org_members om JOIN users u ON u.id = om.user_id WHERE LOWER(u.email) = LOWER($1) AND om.org_id = $2",
    [email, orgId],
  );
  return r.rows[0]?.role ?? null;
}

const scim = (token: string, path: string, init?: RequestInit) =>
  fetch(`${BASE}/scim/v2${path}`, {
    ...init,
    headers: { "Content-Type": "application/scim+json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });

test("SCIM requires a valid bearer token", async () => {
  assert.equal((await fetch(`${BASE}/scim/v2/Users`)).status, 401);
  assert.equal((await scim("fkscim_deadbeefdeadbeef", "/Users")).status, 401);
  assert.equal((await scim(scimToken1, "/Users")).status, 200);
});

test("ServiceProviderConfig advertises PATCH + filter support", async () => {
  const res = await scim(scimToken1, "/ServiceProviderConfig");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.patch.supported, true);
  assert.equal(body.filter.supported, true);
});

const userEmail = `provisioned.${Date.now()}@test.local`;
let scimUserId = "";

test("POST /Users provisions a user + grants org membership", async () => {
  const res = await scim(scimToken1, "/Users", {
    method: "POST",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: userEmail,
      name: { givenName: "Pro", familyName: "Visioned" },
      emails: [{ value: userEmail, primary: true }],
      active: true,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id, "must return a SCIM id");
  assert.equal(body.active, true);
  scimUserId = body.id;
  // The provisioning effect: a real org membership now exists.
  assert.equal(await membershipRole(orgId1, userEmail), "viewer", "provisioned user must be an org member");
});

test("filter lookup by userName finds the provisioned user (pre-create check)", async () => {
  const res = await scim(scimToken1, `/Users?filter=${encodeURIComponent(`userName eq "${userEmail}"`)}`);
  const body = await res.json();
  assert.equal(body.totalResults, 1);
  assert.equal(body.Resources[0].userName, userEmail);
});

test("PATCH active:false DEACTIVATES — membership is removed (access revoked)", async () => {
  const res = await scim(scimToken1, `/Users/${scimUserId}`, {
    method: "PATCH",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).active, false);
  // The control: the org_members row is gone, so requireAuth 401s them next request.
  assert.equal(await membershipRole(orgId1, userEmail), null, "deactivated user must lose org membership");
});

test("PATCH active:true REACTIVATES — membership restored", async () => {
  const res = await scim(scimToken1, `/Users/${scimUserId}`, {
    method: "PATCH",
    body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: true }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(await membershipRole(orgId1, userEmail), "viewer");
});

test("DELETE /Users deprovisions — membership gone, resource 404s", async () => {
  assert.equal((await scim(scimToken1, `/Users/${scimUserId}`, { method: "DELETE" })).status, 204);
  assert.equal(await membershipRole(orgId1, userEmail), null);
  assert.equal((await scim(scimToken1, `/Users/${scimUserId}`)).status, 404);
});

test("a refresh token issued before sessions_revoked_at is rejected (deactivation revokes refresh)", async () => {
  // SCIM users have no password, so we can't hold their refresh token directly.
  // Register a normal user (gets a refresh token), then stamp the same
  // session-revocation watermark SCIM deactivation sets — the refresh must die.
  const email = `revoke.${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "Revoke Me" }),
  });
  const { refreshToken } = (await reg.json()) as { refreshToken: string };

  // Sanity: the refresh works before revocation.
  const before = await fetch(`${BASE}/auth/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }),
  });
  assert.equal(before.status, 200, "refresh should work before revocation");
  const { refreshToken: rotated } = (await before.json()) as { refreshToken: string };

  // Stamp the watermark 2s in the future so it's unambiguously after the token's
  // (second-resolution) iat — simulating SCIM deactivate's UPDATE.
  await db.query("UPDATE users SET sessions_revoked_at = NOW() + INTERVAL '2 seconds' WHERE LOWER(email) = LOWER($1)", [email]);

  const after = await fetch(`${BASE}/auth/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: rotated }),
  });
  assert.equal(after.status, 401, "a pre-watermark refresh token must be rejected");
});

test("SCIM resources are RLS-isolated per org (org2 token can't see org1 users)", async () => {
  // Provision a user in org1, then list users with org2's token — must not appear.
  const email = `iso.${Date.now()}@test.local`;
  const created = await scim(scimToken1, "/Users", {
    method: "POST",
    body: JSON.stringify({ userName: email, emails: [{ value: email, primary: true }], active: true }),
  });
  const id = (await created.json()).id;

  const org2List = await scim(scimToken2, "/Users");
  const body = await org2List.json();
  const leaked = (body.Resources ?? []).some((u: { userName?: string }) => u.userName === email);
  assert.equal(leaked, false, "org2 must not see org1's SCIM users");
  // And org2 can't fetch org1's resource by id.
  assert.equal((await scim(scimToken2, `/Users/${id}`)).status, 404);
  // org1 still owns it.
  assert.equal((await scim(scimToken1, `/Users/${id}`)).status, 200);
});
