/**
 * Mass-assignment + API-key permission inheritance + artifact-path
 * traversal smoke. These are the "basics that quietly bite" once a
 * codebase grows past its initial review pass:
 *
 *   1. Mass assignment — routes that destructure req.body must only
 *      accept the fields they explicitly name. Anything else (role,
 *      email_verified, failed_login_attempts) is attacker-controlled
 *      and must be silently dropped. A test here pins the
 *      destructure pattern so a future refactor that switches to
 *      `Object.assign(user, req.body)` (or equivalent) is caught.
 *
 *   2. API-key permission inheritance — a key issued by a viewer
 *      must NOT carry admin privileges on the routes it authenticates.
 *      auth.ts:104 reads org_members.role for the key's user; this
 *      file verifies that a viewer's key gets a 403 from POST
 *      /webhooks and the owner's key gets a 200.
 *
 *   3. Artifact-path traversal — GET /uploads/runs/<id>/... must not
 *      allow `..` segments to escape the run directory or cross-run
 *      ownership boundaries. Express's static middleware handles the
 *      OS-level traversal but the requireRunOwnership regex sits in
 *      front of that, so a malicious path can still 404 either
 *      because the regex doesn't match (good) or because the OS
 *      can't resolve it (also good).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3984;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;

interface UserCtx {
  email: string;
  token: string;
  orgId: number;
  userId: number;
  apiKey?: string;
}

let owner: UserCtx;
let viewer: UserCtx;

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

async function registerOwner(label: string): Promise<UserCtx> {
  const email = `sec+owner+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `SecOwner-${label}`,
      org_name: `SecOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register owner failed: ${res.status}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

async function inviteViewer(ownerCtx: UserCtx): Promise<UserCtx> {
  // The cleanest way to get a real viewer-role member of a real
  // org: register a second user, then have the owner invite them
  // and accept. Mirrors the pattern in auth_tokens.smoke.test.ts.
  const email = `sec+viewer+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "SecViewer",
      org_name: `SecViewerOwn-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`viewer register failed: ${reg.status}`);
  const regData = (await reg.json()) as { token: string; user: { id: number } };

  const inv = await fetch(`${BASE}/orgs/${ownerCtx.orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerCtx.token}` },
    body: JSON.stringify({ email, role: "viewer" }),
  });
  if (!inv.ok) throw new Error(`invite create failed: ${inv.status}`);
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;

  const accept = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regData.token}` },
  });
  if (!accept.ok) throw new Error(`accept failed: ${accept.status}`);
  const acceptData = (await accept.json()) as { token: string };

  return {
    email,
    token: acceptData.token,
    orgId: ownerCtx.orgId,
    userId: regData.user.id,
  };
}

async function issueApiKey(userCtx: UserCtx): Promise<string> {
  const res = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userCtx.token}` },
    body: JSON.stringify({ name: `key-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`api-key create failed: ${res.status}`);
  return ((await res.json()) as { key: string }).key;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "sec-hardening-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Plenty of headroom — none of the tests in here exercise
      // the auth limiter.
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
  viewer = await inviteViewer(owner);
  owner.apiKey = await issueApiKey(owner);
  viewer.apiKey = await issueApiKey(viewer);
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Mass assignment — /auth/register must not honour privileged fields ─

test("POST /auth/register silently drops attacker-controlled `role` / `email_verified` / `failed_login_attempts` / `locked_until` fields", async () => {
  const email = `sec-mass+register+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "Mass Smuggle",
      org_name: "MassOrg",
      // Attacker-controlled fields — none of these are in the
      // route's destructure list (auth.ts:103). If the route were
      // ever refactored to spread req.body wholesale, this test
      // would catch the regression.
      role: "admin",
      email_verified: true,
      failed_login_attempts: -1000,
      locked_until: null,
      id: 999999,
      password_hash: "$2a$12$bcrypt-overwrite-attempt",
    }),
  });
  assert.equal(res.status, 201, "register should succeed; the route should ignore the smuggled fields, not 400");

  // Verify in the DB that none of the smuggled fields landed.
  const row = await dbAdmin.query(
    "SELECT role, email_verified, failed_login_attempts, locked_until, password_hash FROM users WHERE email = $1",
    [email.toLowerCase()],
  );
  assert.equal(row.rows.length, 1);
  assert.notEqual(
    row.rows[0].role,
    "admin",
    "smuggled role=admin must not be honoured — registration always lands a non-admin user",
  );
  assert.equal(
    row.rows[0].email_verified,
    false,
    "smuggled email_verified=true must not bypass the verification flow",
  );
  assert.equal(
    row.rows[0].failed_login_attempts,
    0,
    "smuggled failed_login_attempts must not be persisted from the request body",
  );
  assert.equal(row.rows[0].locked_until, null, "locked_until must be NULL on a fresh registration regardless of body");
  assert.notEqual(
    row.rows[0].password_hash,
    "$2a$12$bcrypt-overwrite-attempt",
    "smuggled password_hash must not replace the bcrypt'd password",
  );
});

test("POST /auth/login silently drops attacker-controlled `email_verified` / `role` / `locked_until` fields", async () => {
  // Same threat on login: a smuggled `locked_until: null` or
  // `email_verified: true` must not affect the route's reads from
  // the DB row. Login should still hit the wrong-password branch.
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: owner.email,
      password: "deliberately-wrong",
      role: "admin",
      email_verified: true,
      locked_until: null,
      failed_login_attempts: 0,
    }),
  });
  assert.equal(res.status, 401, "wrong password must still 401; smuggled fields must not alter the credential check");
});

test("POST /webhooks silently drops attacker-controlled `active` / `org_id` fields (mass-assignment on a tenancy column)", async () => {
  // /webhooks's destructure list intentionally omits `active` and
  // `org_id`; an attacker should not be able to set the row's
  // org_id to point at another tenant or pre-disable a webhook
  // for plausible-deniability cover.
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({
      name: "mass-assign-test",
      url: "https://example.invalid/hook",
      events: ["run.failed"],
      platform: "generic",
      org_id: 999999,
      active: false,
      created_at: "1970-01-01T00:00:00Z",
    }),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: number };

  const row = await dbAdmin.query(
    "SELECT org_id, active FROM webhooks WHERE id = $1",
    [created.id],
  );
  assert.equal(
    row.rows[0].org_id,
    owner.orgId,
    "webhook's org_id must come from the JWT, never the request body — otherwise a viewer could plant a webhook in another tenant's org",
  );
  // `active` defaults to true at the column level; a smuggled
  // `active: false` must not have stuck.
  assert.equal(row.rows[0].active, true, "smuggled active=false must be ignored — webhooks default to active=true");
});

// ── API-key permission inheritance — viewer's key cannot escalate ───────

test("API key from a viewer-role member 403s on admin-only routes (no privilege escalation via the key)", async () => {
  // The viewer holds a valid API key. Calling POST /webhooks
  // (admin/owner-only per routes/webhooks.ts:57) must 403 — not
  // 401, not 201. A regression that authenticated the key without
  // re-reading org_members.role would silently grant the viewer
  // admin powers.
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewer.apiKey}` },
    body: JSON.stringify({
      name: "viewer-escalation-attempt",
      url: "https://example.invalid/escalate",
      events: ["run.failed"],
      platform: "generic",
    }),
  });
  assert.equal(
    res.status,
    403,
    "viewer's API key must 403 on admin-only routes — the key must inherit the viewer's org role, not grant fresh privilege",
  );
});

test("API key from an owner can call the admin-only POST /webhooks (positive control for the viewer test above)", async () => {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.apiKey}` },
    body: JSON.stringify({
      name: "owner-key-positive-control",
      url: "https://example.invalid/owner-hook",
      events: ["run.failed"],
      platform: "generic",
    }),
  });
  assert.equal(res.status, 201, "owner API key must authenticate as owner — otherwise the 403 above is a false positive");
});

// ── /uploads/ artifact path traversal ──────────────────────────────────

test("GET /uploads/../etc/passwd is blocked — no escape out of the uploads directory", async () => {
  const res = await fetch(`${BASE}/uploads/../etc/passwd?token=${owner.token}`);
  // Express's mountpath middleware collapses path traversal before
  // the static handler runs. The result must be 4xx (404, 403, or
  // 400) — never 200 with /etc/passwd contents.
  assert.ok(
    res.status >= 400 && res.status < 500,
    `path traversal attempt must 4xx; got ${res.status} — a 200 means the host filesystem leaked`,
  );
  // Sanity-check the body so a future regression where 200 +
  // "Not Found" body slips through is still caught.
  const body = await res.text().catch(() => "");
  assert.ok(
    !body.includes("root:") && !body.includes("nobody:"),
    "response must not contain /etc/passwd content",
  );
});

test("GET /uploads/runs/<A>/../<B>/x — cross-run ownership boundary is not escapable via path traversal", async () => {
  // The requireRunOwnership middleware matches /^\/runs\/(\d+)\//
  // against req.path. With a `..` segment, the regex either
  // (a) still matches the first run id and the static handler
  // collapses the path to a different file, OR (b) the path is
  // normalised before the regex fires and the static handler
  // returns the resolved file scoped to the second run.
  // Either way: if the caller doesn't own the resolved run, the
  // request must NOT serve content. Use a high run id (999999) as
  // the traversal target so no real run is reachable.
  const res = await fetch(
    `${BASE}/uploads/runs/1/..%2F999999%2Fanything.png?token=${owner.token}`,
  );
  // Acceptable outcomes: 404 (no such artifact / no such run),
  // 403 (ownership), or 401 (token check). Anything < 400 is a
  // cross-run leak.
  assert.ok(
    res.status >= 400 && res.status < 500,
    `cross-run traversal must 4xx; got ${res.status}`,
  );
});

test("GET /uploads/runs/<id>/x with a NULL-byte filename is rejected — no truncation to a different artifact", async () => {
  // NULL-byte truncation (CVE-class) is a classic static-file
  // bypass: ask for `secret.gz%00.png` hoping the underlying fs
  // layer drops everything after \0. Node's fs APIs reject paths
  // containing NUL outright (ERR_INVALID_ARG_VALUE), but pin it
  // here so a future custom static handler can't regress.
  const res = await fetch(`${BASE}/uploads/runs/1/secret.gz%00.png?token=${owner.token}`);
  assert.ok(
    res.status >= 400 && res.status < 500,
    `NULL-byte in path must 4xx; got ${res.status}`,
  );
});

test("GET /uploads without an Authorization header or ?token= returns 401, not 200", async () => {
  // No token query, no Authorization header. The promoteUploadToken
  // shim must NOT fabricate a Bearer header from anywhere else, and
  // requireAuth must short-circuit before requireRunOwnership runs.
  const res = await fetch(`${BASE}/uploads/runs/1/x`);
  assert.equal(res.status, 401, "unauthenticated /uploads access must 401");
});

test("GET /uploads/?token=<empty-string> doesn't accidentally promote to `Bearer ` and 401 still fires", async () => {
  // Edge case in promoteUploadToken: `t = req.query.token` is a
  // string, but an empty one. The shim must not call
  // `req.headers.authorization = 'Bearer '` (empty bearer) — that
  // would push the request into requireAuth's "Bearer " branch
  // which still 401s correctly, but pin it so a future tweak to
  // the shim can't accidentally accept the empty token as valid.
  const res = await fetch(`${BASE}/uploads/runs/1/x?token=`);
  assert.equal(res.status, 401, "empty ?token= must not authenticate; the empty-bearer branch must still 401");
});
