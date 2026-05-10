/**
 * Session-staleness smoke.
 *
 * JWTs carry orgId+orgRole baked in at sign-time. Without a
 * server-side re-check on every request, a kicked-out member
 * keeps full access until their access token's exp (up to 1h).
 * The fix in auth.ts:requireAuth re-reads org_members on every
 * accepted JWT / cookie token. The API key path already reads
 * org_members in verifyApiKey, and was extended to refuse the
 * key entirely when the user is no longer a member (previously
 * it silently downgraded them to 'viewer'). This file pins both
 * paths:
 *
 *   1. JWT from a user removed from their org → 401 on the next
 *      authenticated request (no waiting for exp).
 *   2. API key from a user removed from the org their key was
 *      issued for → 401, not the previous "act as viewer" path.
 *   3. Role downgrade (owner → viewer) reflects on the next
 *      request: an admin-only route now 403s for the downgraded
 *      user even though their JWT still claims orgRole='owner'.
 *   4. The httpOnly cookie path is re-checked too — not just the
 *      Authorization header.
 *
 * The DELETE /orgs/:id/members/:userId route is owner/admin
 * only, so this file boots a "host" org with two members
 * (admin owner + invited viewer/admin) and runs the admin
 * mutations as the host while exercising the target user's
 * token as the candidate.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3980;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;

interface Member {
  email: string;
  token: string;
  userId: number;
  apiKey: string;
}

interface Host {
  email: string;
  token: string;
  userId: number;
  orgId: number;
}

let host: Host;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

async function registerHost(): Promise<Host> {
  const email = `staleness-host+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "Staleness Host",
      org_name: `StalenessHostOrg-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`host register failed: ${res.status}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, userId: data.user.id, orgId: data.user.orgId };
}

async function inviteMember(hostCtx: Host, role: "viewer" | "admin"): Promise<Member> {
  const email = `staleness-member+${role}+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `Staleness-${role}`,
      org_name: `StalenessOwn-${role}-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`member register failed: ${reg.status}`);
  const regData = (await reg.json()) as { token: string; user: { id: number } };

  const inv = await fetch(`${BASE}/orgs/${hostCtx.orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostCtx.token}` },
    body: JSON.stringify({ email, role }),
  });
  if (!inv.ok) throw new Error(`invite create failed: ${inv.status}`);
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;

  const accept = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regData.token}` },
  });
  if (!accept.ok) throw new Error(`accept failed: ${accept.status}`);
  const acceptData = (await accept.json()) as { token: string };

  const keyRes = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${acceptData.token}` },
    body: JSON.stringify({ name: `staleness-key-${Date.now()}` }),
  });
  if (!keyRes.ok) throw new Error(`api-key create failed: ${keyRes.status}`);
  const apiKey = ((await keyRes.json()) as { key: string }).key;

  return { email, token: acceptData.token, userId: regData.user.id, apiKey };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "session-staleness-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  host = await registerHost();
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── JWT for a removed member is rejected on the next request ────────────

test("JWT from a removed member 401s on the next authenticated request (no waiting for exp)", async () => {
  const m = await inviteMember(host, "viewer");

  // Sanity: while still a member, /auth/me succeeds.
  const before = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${m.token}` } });
  assert.equal(before.status, 200, "control: pre-removal /auth/me must succeed");

  // Host removes the member.
  const del = await fetch(`${BASE}/orgs/${host.orgId}/members/${m.userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${host.token}` },
  });
  assert.ok(del.ok, `member removal should succeed; got ${del.status}`);

  // The removed member's JWT is still cryptographically valid
  // (signature OK, exp in the future) but the session is now
  // stale — requireAuth's org_members re-check must 401.
  const after = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${m.token}` } });
  assert.equal(
    after.status,
    401,
    "removed member's JWT must 401 on the next request — anything else means a kicked-out member retains access until JWT exp",
  );
});

// ── API key for a removed member is rejected ────────────────────────────

test("API key issued before removal stops working the moment the member is removed", async () => {
  const m = await inviteMember(host, "viewer");

  // Sanity: the key works while the user is still a member.
  const before = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${m.apiKey}` } });
  assert.equal(before.status, 200, "control: pre-removal API-key /auth/me must succeed");

  await fetch(`${BASE}/orgs/${host.orgId}/members/${m.userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${host.token}` },
  });

  const after = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${m.apiKey}` } });
  assert.equal(
    after.status,
    401,
    "removed member's API key must 401 — verifyApiKey must refuse a key whose user is no longer in the key's org, not silently downgrade to viewer",
  );
});

// ── Role downgrade is honoured on the next request ──────────────────────

test("role downgrade (admin → viewer) takes effect on the next request, not at JWT exp", async () => {
  const m = await inviteMember(host, "admin");

  // While admin, the member can create a webhook (admin-only
  // route). This is the positive control.
  const ok = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.token}` },
    body: JSON.stringify({
      name: "before-downgrade",
      url: "https://example.invalid/hook",
      events: ["run.failed"],
      platform: "generic",
    }),
  });
  assert.equal(ok.status, 201, "control: pre-downgrade admin can create webhook");

  // Host downgrades to viewer.
  const patch = await fetch(`${BASE}/orgs/${host.orgId}/members/${m.userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.ok(patch.ok, `role change should succeed; got ${patch.status}`);

  // The member's JWT still claims orgRole='admin', but
  // requireAuth must refresh from org_members so the role-gated
  // handler sees the live 'viewer' role and 403s.
  const after = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.token}` },
    body: JSON.stringify({
      name: "after-downgrade",
      url: "https://example.invalid/hook2",
      events: ["run.failed"],
      platform: "generic",
    }),
  });
  assert.equal(
    after.status,
    403,
    "downgraded member must 403 on admin-only routes — orgRole must be refreshed from org_members, not read from the stale JWT claim",
  );
});

// ── Cookie path is re-validated too ────────────────────────────────────

test("flakey_token cookie path is re-validated against org_members (same contract as the Bearer path)", async () => {
  const m = await inviteMember(host, "viewer");

  // Sanity: pre-removal, the cookie works on /auth/me.
  const before = await fetch(`${BASE}/auth/me`, {
    headers: { Cookie: `flakey_token=${m.token}` },
  });
  assert.equal(before.status, 200, "control: pre-removal cookie must authenticate");

  await fetch(`${BASE}/orgs/${host.orgId}/members/${m.userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${host.token}` },
  });

  const after = await fetch(`${BASE}/auth/me`, {
    headers: { Cookie: `flakey_token=${m.token}` },
  });
  assert.equal(
    after.status,
    401,
    "removed member's cookie token must also 401 — re-validation must cover both the Bearer and cookie paths uniformly",
  );
});
