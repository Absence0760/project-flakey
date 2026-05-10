/**
 * Audit-log coverage smoke.
 *
 * Several privileged operations were not writing to audit_log,
 * which leaves forensic gaps after a compromise: API-key issuance
 * (long-lived credential creation), API-key revocation, member
 * removal, and role changes were all silent. logAudit calls have
 * been added to those routes; this file pins them so a future
 * refactor that drops the call gets caught.
 *
 * The strategy is straightforward: perform the privileged action
 * via the HTTP API, then SELECT FROM audit_log via an admin DB
 * client and assert (a) the row exists, (b) the action string
 * matches the documented value, (c) for state-change ops, the
 * detail JSONB carries the before/after values an investigator
 * needs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3979;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;

interface OwnerCtx {
  email: string;
  token: string;
  userId: number;
  orgId: number;
}

let owner: OwnerCtx;

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

async function registerOwner(label: string): Promise<OwnerCtx> {
  const email = `audit-owner+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `AuditOwner-${label}`,
      org_name: `AuditOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, userId: data.user.id, orgId: data.user.orgId };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "audit-coverage-test-secret",
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

  owner = await registerOwner("primary");
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── API-key issuance + revocation are audited ──────────────────────────

test("POST /auth/api-keys writes an audit_log row with action='auth.api_key.create' and the key prefix", async () => {
  // Use a unique label so we can grep the audit row deterministically.
  const label = `audit-create-${Date.now()}`;
  const res = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ label }),
  });
  assert.equal(res.status, 201);
  const { key, prefix } = (await res.json()) as { key: string; prefix: string };
  assert.ok(key.startsWith("fk_"));

  const rows = await dbAdmin.query(
    `SELECT action, user_id, target_type, detail
     FROM audit_log
     WHERE org_id = $1 AND action = 'auth.api_key.create' AND detail->>'label' = $2
     ORDER BY id DESC LIMIT 1`,
    [owner.orgId, label],
  );
  assert.equal(rows.rows.length, 1, "api_key.create audit row must be present after the route call");
  assert.equal(rows.rows[0].user_id, owner.userId, "audit row must record the acting user");
  assert.equal(rows.rows[0].target_type, "api_key");
  assert.equal(
    rows.rows[0].detail.prefix,
    prefix,
    "audit detail must include the prefix so reviewers can identify the row without the raw key",
  );
  // The raw key value must NEVER appear in audit_log — it's a
  // long-lived credential and the audit log is a query surface for
  // any admin. Verify the prefix is enough.
  assert.ok(
    !JSON.stringify(rows.rows[0].detail).includes(key),
    "audit detail must NOT contain the raw API key — only the prefix",
  );
});

test("DELETE /auth/api-keys/:id writes an audit_log row with action='auth.api_key.delete'", async () => {
  // Issue then immediately revoke.
  const created = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ label: `audit-delete-${Date.now()}` }),
  });
  const createdBody = (await created.json()) as { prefix: string };
  // The route doesn't return the id directly; look it up by prefix.
  const idRow = await dbAdmin.query(
    "SELECT id FROM api_keys WHERE org_id = $1 AND key_prefix = $2",
    [owner.orgId, createdBody.prefix],
  );
  const keyId = idRow.rows[0].id as number;

  const del = await fetch(`${BASE}/auth/api-keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(del.status, 200);

  const audit = await dbAdmin.query(
    `SELECT action, target_id, detail
     FROM audit_log
     WHERE org_id = $1 AND action = 'auth.api_key.delete' AND target_id = $2
     ORDER BY id DESC LIMIT 1`,
    [owner.orgId, String(keyId)],
  );
  assert.equal(audit.rows.length, 1, "api_key.delete audit row must be present after revocation");
  assert.equal(audit.rows[0].detail.prefix, createdBody.prefix, "audit detail must include the revoked key's prefix");
});

// ── Member removal + role change are audited ───────────────────────────

test("DELETE /orgs/:id/members/:userId writes an audit_log row with action='org.member.remove'", async () => {
  // Invite + accept a second member, then remove them.
  const inviteeEmail = `audit-remove+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: inviteeEmail,
      password: "testpass123",
      name: "Removable",
      org_name: `RemovableOwn-${Date.now()}`,
    }),
  });
  const inviteeUserId = ((await reg.json()) as { user: { id: number } }).user.id;

  // Real path: invite, accept, then remove.
  const inv = await fetch(`${BASE}/orgs/${owner.orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
  });
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;
  // Need the invitee's own session token to accept. Re-login for it.
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: inviteeEmail, password: "testpass123" }),
  });
  const inviteeToken = ((await login.json()) as { token: string }).token;
  await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${inviteeToken}` },
  });

  const del = await fetch(`${BASE}/orgs/${owner.orgId}/members/${inviteeUserId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(del.status, 200);

  const audit = await dbAdmin.query(
    `SELECT action, user_id, target_id
     FROM audit_log
     WHERE org_id = $1 AND action = 'org.member.remove' AND target_id = $2
     ORDER BY id DESC LIMIT 1`,
    [owner.orgId, String(inviteeUserId)],
  );
  assert.equal(audit.rows.length, 1, "member.remove must write an audit row");
  assert.equal(audit.rows[0].user_id, owner.userId, "audit must record the acting admin, not the removed user");
});

test("PATCH /orgs/:id/members/:userId writes an audit_log row with action='org.member.role_change' and from/to detail", async () => {
  const inviteeEmail = `audit-role+${Date.now()}@test.local`;
  await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: inviteeEmail,
      password: "testpass123",
      name: "RoleChange",
      org_name: `RoleChangeOwn-${Date.now()}`,
    }),
  });

  const inv = await fetch(`${BASE}/orgs/${owner.orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
  });
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: inviteeEmail, password: "testpass123" }),
  });
  const inviteeToken = ((await login.json()) as { token: string }).token;
  await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${inviteeToken}` },
  });

  const inviteeRow = await dbAdmin.query(
    "SELECT id FROM users WHERE email = $1",
    [inviteeEmail.toLowerCase()],
  );
  const inviteeUserId = inviteeRow.rows[0].id as number;

  // Promote viewer → admin.
  const patch = await fetch(`${BASE}/orgs/${owner.orgId}/members/${inviteeUserId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(patch.status, 200);

  const audit = await dbAdmin.query(
    `SELECT action, target_id, detail
     FROM audit_log
     WHERE org_id = $1 AND action = 'org.member.role_change' AND target_id = $2
     ORDER BY id DESC LIMIT 1`,
    [owner.orgId, String(inviteeUserId)],
  );
  assert.equal(audit.rows.length, 1, "role_change must write an audit row");
  assert.equal(audit.rows[0].detail.from, "viewer", "detail must record the previous role for forensic trajectory");
  assert.equal(
    audit.rows[0].detail.to,
    "admin",
    "detail must record the new role — viewer→admin is the privilege-elevation event a reviewer most needs to see",
  );
});
