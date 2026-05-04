/**
 * Role-based permission smoke tests.
 *
 * Three roles exist: owner, admin, viewer.  Several routes guard
 * mutations behind `orgRole === "viewer" → 403` (jira/settings,
 * pagerduty/settings, reports, webhooks, visual approval, ui-coverage
 * routes inventory, audit-log retention, coverage settings).  None of
 * these are tested today.  A regression that drops one of those guards
 * is a privilege-escalation bug — a viewer could rotate the org's Jira
 * token or change webhook URLs.
 *
 * This file registers an owner, invites a viewer through the real
 * invite-accept flow, then issues each guarded mutation as the viewer
 * and asserts 403.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let ownerToken: string;
let ownerOrgId: number;
let viewerToken: string;

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

async function register(label: string): Promise<{ email: string; token: string; orgId: number }> {
  const email = `perm+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: label,
      org_name: `PermOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as { token: string; user: { orgId: number } };
  return { email, token: data.token, orgId: data.user.orgId };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "perm-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Owner — creates org and is automatically owner.
  const owner = await register("owner");
  ownerToken = owner.token;
  ownerOrgId = owner.orgId;

  // Future viewer — registers their own org, then we'll invite them
  // into the owner's org as a viewer.  Once they accept the invite,
  // their token is scoped to the owner's org with role=viewer.
  const viewer = await register("viewer");

  // Owner invites the viewer by email.
  const invite = await fetch(`${BASE}/orgs/${ownerOrgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email: viewer.email, role: "viewer" }),
  });
  if (!invite.ok) {
    const body = await invite.text().catch(() => "");
    throw new Error(`invite failed: ${invite.status} ${body}`);
  }
  const inviteData = (await invite.json()) as { invite_token: string };

  // Viewer accepts (using their own token; the route checks email match).
  const accept = await fetch(`${BASE}/orgs/invites/${inviteData.invite_token}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewer.token}` },
  });
  if (!accept.ok) {
    const body = await accept.text().catch(() => "");
    throw new Error(`accept failed: ${accept.status} ${body}`);
  }
  const acceptData = (await accept.json()) as { token: string; user: { orgRole: string; orgId: number } };
  assert.equal(acceptData.user.orgRole, "viewer", "invite-accept must scope to viewer role");
  assert.equal(acceptData.user.orgId, ownerOrgId, "invite-accept must scope to the inviter's org");
  viewerToken = acceptData.token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

function asViewer() {
  return {
    get: (path: string) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${viewerToken}` } }),
    post: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
        body: JSON.stringify(body),
      }),
    patch: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
        body: JSON.stringify(body),
      }),
    delete: (path: string) =>
      fetch(`${BASE}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${viewerToken}` } }),
  };
}

// ── Read-only access for viewers ─────────────────────────────────────────

test("viewer CAN read /runs, /jira/settings, /pagerduty/settings, /manual-tests, /releases", async () => {
  // Reads that the viewer should still be able to make.
  for (const path of ["/runs", "/jira/settings", "/pagerduty/settings", "/manual-tests", "/releases"]) {
    const res = await asViewer().get(path);
    assert.equal(res.status, 200, `viewer should be able to GET ${path}, got ${res.status}`);
  }
});

test("viewer CANNOT GET /webhooks (URL contains secrets)", async () => {
  // Slack/Discord/Teams webhook URLs are credentials — listing them
  // exposes the secret.  This route is intentionally admin-only on
  // both read and write paths.
  const res = await asViewer().get("/webhooks");
  assert.equal(res.status, 403);
});

// ── Mutation guards ──────────────────────────────────────────────────────

test("viewer cannot PATCH /jira/settings (privilege escalation guard)", async () => {
  const res = await asViewer().patch("/jira/settings", {
    base_url: "https://attacker.example",
    api_token: "exfiltrated",
  });
  assert.equal(res.status, 403, "viewer must NOT be able to rotate the org's Jira token");
});

test("viewer cannot PATCH /pagerduty/settings", async () => {
  const res = await asViewer().patch("/pagerduty/settings", {
    integration_key: "attacker-key",
    auto_trigger: true,
  });
  assert.equal(res.status, 403, "viewer must NOT be able to redirect PagerDuty incidents");
});

test("viewer cannot POST /webhooks", async () => {
  const res = await asViewer().post("/webhooks", {
    url: "https://attacker.example/exfil",
    platform: "slack",
  });
  assert.equal(res.status, 403, "viewer must NOT be able to add a webhook target");
});

test("viewer cannot POST /reports (scheduled reports)", async () => {
  const res = await asViewer().post("/reports", {
    name: "leaked",
    cadence: "daily",
    delivery: "email",
    recipient: "attacker@example.com",
  });
  assert.equal(res.status, 403);
});

test("viewer cannot PATCH /coverage/settings", async () => {
  const res = await asViewer().patch("/coverage/settings", {
    coverage_threshold: 0,
    coverage_gate_enabled: false,
  });
  assert.equal(res.status, 403, "viewer must not be able to disable coverage PR gating");
});

test("viewer cannot POST /ui-coverage/routes (inventory mutation)", async () => {
  const res = await asViewer().post("/ui-coverage/routes", { routes: ["/leaked"] });
  assert.equal(res.status, 403);
});

// ── Owner sanity-check ───────────────────────────────────────────────────

test("owner CAN do all of the above", async () => {
  // Confirm the 403s above were due to role, not because the route is
  // broken for everyone.  Use the owner token for a representative
  // mutation on each guarded route.
  const calls: Array<[string, "PATCH" | "POST", string, unknown]> = [
    ["/jira/settings", "PATCH", "PATCH /jira/settings",
      { base_url: "https://x.atlassian.net", email: "a@b.com", api_token: "tok", project_key: "QA" }],
    ["/pagerduty/settings", "PATCH", "PATCH /pagerduty/settings",
      { integration_key: "k", severity: "warning", auto_trigger: true }],
    ["/webhooks", "POST", "POST /webhooks",
      { url: "https://hooks.example/owner", platform: "slack" }],
    ["/coverage/settings", "PATCH", "PATCH /coverage/settings",
      { coverage_threshold: 80, coverage_gate_enabled: true }],
  ];
  for (const [path, method, label, body] of calls) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify(body),
    });
    assert.ok(res.ok, `owner should succeed at ${label}, got ${res.status}`);
  }
});

// ── Sensitive value never leaked back ────────────────────────────────────

test("GET /jira/settings never returns the api_token field (only a flag)", async () => {
  // Set a token first, then read.
  const set = await fetch(`${BASE}/jira/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ base_url: "https://x.atlassian.net", email: "a@b.com", api_token: "SECRET", project_key: "QA" }),
  });
  assert.equal(set.status, 200);

  const get = await fetch(`${BASE}/jira/settings`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const data = (await get.json()) as Record<string, unknown>;
  assert.equal(data.has_api_token, true, "has_api_token flag should reflect the stored token");
  assert.equal(data.api_token, undefined, "api_token must never be returned by GET /jira/settings");
  // Belt + suspenders: serialized response must not contain the cleartext
  // anywhere (would catch a leak in some other field name like
  // `api_token_encrypted` or `_raw`).
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes("SECRET"), "raw Jira token leaked in GET /jira/settings response");
});

// ── Webhook URL validation (SSRF / scheme defense) ─────────────────────

test("POST /webhooks rejects file:// URLs", async () => {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ url: "file:///etc/passwd", platform: "generic" }),
  });
  assert.equal(res.status, 400, "file:// URLs must be rejected at create time");
});

test("POST /webhooks rejects javascript: URLs", async () => {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ url: "javascript:alert(1)", platform: "generic" }),
  });
  assert.equal(res.status, 400, "javascript: scheme must be rejected");
});

test("POST /webhooks rejects malformed URLs", async () => {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ url: "not a url at all", platform: "generic" }),
  });
  assert.equal(res.status, 400, "non-URL strings must be rejected");
});

test("POST /webhooks accepts http and https", async () => {
  for (const url of ["http://hooks.example/test", "https://hooks.example/test"]) {
    const res = await fetch(`${BASE}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ url, platform: "generic" }),
    });
    assert.equal(res.status, 201, `expected ${url} to be accepted, got ${res.status}`);
  }
});

test("PATCH /webhooks/:id rejects invalid scheme even if existing record is fine", async () => {
  // Create a valid webhook first.
  const create = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ url: "https://hooks.example/initial", platform: "generic" }),
  });
  assert.equal(create.status, 201);
  const { id } = (await create.json()) as { id: number };

  // Try to PATCH it to a file:// URL.
  const patch = await fetch(`${BASE}/webhooks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ url: "file:///etc/passwd" }),
  });
  assert.equal(patch.status, 400, "PATCH with bad scheme must be rejected (defense-in-depth)");
});

test("GET /pagerduty/settings never returns the integration_key field", async () => {
  const set = await fetch(`${BASE}/pagerduty/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ integration_key: "PD-SECRET-KEY", severity: "warning", auto_trigger: true }),
  });
  assert.equal(set.status, 200);

  const get = await fetch(`${BASE}/pagerduty/settings`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const data = (await get.json()) as Record<string, unknown>;
  assert.equal(data.has_key, true);
  assert.equal(data.integration_key, undefined, "integration_key must never be returned by GET");
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes("PD-SECRET-KEY"), "raw PagerDuty key leaked in GET response");
});
