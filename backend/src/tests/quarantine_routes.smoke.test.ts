/**
 * Phase 15.3 — quarantine route AUTHORIZATION (viewer-gating).
 *
 * 15.3 tightened POST and DELETE /quarantine from requireAuth-only to a
 * role-gated mutation: a viewer can READ the quarantine list but must NOT be
 * able to mute (POST) or un-mute (DELETE) a test — the same gate the /errors
 * triage mutations carry. This locks that authorization change so it can't
 * silently regress back to "any authenticated user can quarantine".
 *
 *   - viewer  → 403 on POST /quarantine and DELETE /quarantine
 *   - viewer  → 200 on GET /quarantine and GET /quarantine/check (read is allowed)
 *   - admin   → 201 on POST, 200 on DELETE (the mutation succeeds for a non-viewer)
 *   - owner   → 201 on POST (owner is also non-viewer)
 *
 * DB-backed (needs a migrated flakey Postgres; point DB_PORT at it). One backend
 * spawn, three memberships (owner + a second admin + a viewer) in one org.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3910;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;
let ownerToken: string;
let adminToken: string;
let viewerToken: string;
let orgId: number;

async function waitForHealth(maxMs = 12000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

interface Reg { token: string; userId: number; orgId: number; }
async function registerAt(email: string, name: string, stamp: string): Promise<Reg> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name, org_name: `QRoleOrg-${stamp}` }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { token: data.token, userId: data.user.id, orgId: data.user.orgId };
}

/**
 * Move a freshly-registered user's ONLY membership into our org at `role`, then
 * re-login so resolveOrg (orders by joined_at) resolves them into our org with
 * that role. Mirrors the fix_pr / session_staleness viewer-setup pattern.
 */
async function joinOrgAs(reg: Reg, email: string, role: "admin" | "viewer"): Promise<string> {
  await dbAdmin.query(`DELETE FROM org_members WHERE user_id = $1`, [reg.userId]);
  await dbAdmin.query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
    [orgId, reg.userId, role]
  );
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123" }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  return (await login.json() as { token: string }).token;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "quarantine-role-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

  // Owner of our org.
  const ownerStamp = `${Date.now()}-o`;
  const owner = await registerAt(`qrole+owner+${ownerStamp}@test.local`, "Owner", ownerStamp);
  ownerToken = owner.token;
  orgId = owner.orgId;

  // A second user demoted to admin in our org, and a third demoted to viewer.
  const adminStamp = `${Date.now()}-a`;
  const adminEmail = `qrole+admin+${adminStamp}@test.local`;
  const adminReg = await registerAt(adminEmail, "Admin", adminStamp);
  adminToken = await joinOrgAs(adminReg, adminEmail, "admin");

  const viewerStamp = `${Date.now()}-v`;
  const viewerEmail = `qrole+viewer+${viewerStamp}@test.local`;
  const viewerReg = await registerAt(viewerEmail, "Viewer", viewerStamp);
  viewerToken = await joinOrgAs(viewerReg, viewerEmail, "viewer");
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

function postQuarantine(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function deleteQuarantine(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/quarantine`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// ── viewer is blocked from mutating ──────────────────────────────────────────

test("a viewer gets 403 on POST /quarantine (mutation is role-gated, not requireAuth-only)", async () => {
  const suite = `qrole-viewer-post-${Date.now()}`;
  const res = await postQuarantine(viewerToken, { fullTitle: `${suite} > t`, suiteName: suite, reason: "flaky" });
  assert.equal(res.status, 403, await res.text().catch(() => ""));
});

test("a viewer gets 403 on DELETE /quarantine", async () => {
  const suite = `qrole-viewer-del-${Date.now()}`;
  // Seed a row as the owner so the DELETE target genuinely exists — proving the
  // 403 is the role gate, not a 'nothing to delete' path.
  const seed = await postQuarantine(ownerToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(seed.status, 201);

  const res = await deleteQuarantine(viewerToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(res.status, 403);

  // The row survives the rejected DELETE.
  const list = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal((await list.json() as unknown[]).length, 1, "viewer's rejected DELETE must not remove the row");
});

// ── viewer CAN read ──────────────────────────────────────────────────────────

test("a viewer can still READ the quarantine list (GET is not gated)", async () => {
  const suite = `qrole-viewer-read-${Date.now()}`;
  const seed = await postQuarantine(ownerToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(seed.status, 201);

  const list = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json() as unknown[]).length, 1);

  const check = await fetch(`${BASE}/quarantine/check?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(check.status, 200, "GET /quarantine/check is readable by a viewer");
});

// ── owner / admin CAN mutate ──────────────────────────────────────────────────

test("an owner can POST and DELETE /quarantine (non-viewer mutation allowed)", async () => {
  const suite = `qrole-owner-${Date.now()}`;
  const post = await postQuarantine(ownerToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(post.status, 201);

  const del = await deleteQuarantine(ownerToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(del.status, 200);
});

test("an admin (non-owner) can POST and DELETE /quarantine", async () => {
  const suite = `qrole-admin-${Date.now()}`;
  const post = await postQuarantine(adminToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(post.status, 201, await post.text().catch(() => ""));

  const del = await deleteQuarantine(adminToken, { fullTitle: `${suite} > t`, suiteName: suite });
  assert.equal(del.status, 200);
});
