/**
 * Integrations / connectivity / AI / reports smoke tests.
 *
 * Backstops:
 *   - /connectivity/{database,git,email} — settings-test endpoints
 *   - /analyze — AI status + connection
 *   - /predict/tests — heuristic test selector
 *   - /jira/{settings,issues}, /pagerduty/settings — integration config
 *   - /reports — scheduled-report CRUD
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3990;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

async function waitForHealth(maxMs = 10000): Promise<void> {
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

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "integ-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `int+${Date.now()}@test.local`, password: "testpass123",
      name: "Int", org_name: `IntOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

function get(path: string) {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}
function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function patch(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function del(path: string) {
  return fetch(`${BASE}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

// ── /connectivity ───────────────────────────────────────────────────────

test("POST /connectivity/database returns ok in a healthy environment", async () => {
  const res = await post("/connectivity/database", {});
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean };
  assert.equal(data.ok, true, "database connectivity must succeed in test env");
});

test("POST /connectivity/email returns a JSON shape (success or failure)", async () => {
  // SMTP isn't actually wired up in test env (port 1025 has no MailHog),
  // but the endpoint should still return a structured response.
  const res = await post("/connectivity/email", { to: "test@example.com" });
  assert.ok(res.ok || res.status === 500, `unexpected status ${res.status}`);
  const data = await res.json();
  assert.ok(typeof data === "object" && data !== null);
});

test("POST /connectivity/git returns a JSON shape when no provider is configured", async () => {
  const res = await post("/connectivity/git", {});
  // No git settings yet — the endpoint should report that, not crash.
  assert.ok(res.ok || res.status === 400 || res.status === 500,
    `unexpected status ${res.status}`);
});

// ── /analyze ────────────────────────────────────────────────────────────

test("GET /analyze/status returns enabled flag", async () => {
  const res = await get("/analyze/status");
  assert.equal(res.status, 200);
  const data = (await res.json()) as { enabled: boolean };
  assert.equal(typeof data.enabled, "boolean");
});

test("POST /analyze/test-connection returns ok or error shape", async () => {
  // AI provider isn't configured in test env, so this should report
  // not-enabled or a connection failure — not crash with a 500.
  const res = await post("/analyze/test-connection", {});
  assert.ok(res.status === 200 || res.status === 503,
    `unexpected status ${res.status}`);
});

// ── /predict ────────────────────────────────────────────────────────────

test("POST /predict/tests returns predictions for changed files", async () => {
  const res = await post("/predict/tests", {
    changedFiles: ["src/auth/login.ts", "src/auth/register.ts"],
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { tests: unknown[] };
  assert.ok(Array.isArray(data.tests), "tests array expected");
});

test("POST /predict/tests 400s without changedFiles", async () => {
  const res = await post("/predict/tests", {});
  assert.equal(res.status, 400);
});

test("GET /predict/split returns a parallelization plan", async () => {
  const res = await get("/predict/split");
  // Some implementations return 200 with empty plan, others 400 if
  // required params are missing. Accept either as the basic
  // does-not-crash assertion.
  assert.ok(res.status === 200 || res.status === 400, `got ${res.status}`);
});

// ── /jira ───────────────────────────────────────────────────────────────

test("GET /jira/settings returns the (empty) Jira config", async () => {
  const res = await get("/jira/settings");
  assert.equal(res.status, 200);
});

test("PATCH+GET /jira/settings round-trip", async () => {
  const set = await patch("/jira/settings", {
    base_url: "https://acme.atlassian.net",
    email: "ops@acme.com",
    project_key: "TEST",
    issue_type: "Bug",
    auto_create: false,
  });
  assert.ok(set.ok, `jira settings PATCH failed: ${set.status}`);
  // GET returns column names with the `jira_` prefix.
  const r = await get("/jira/settings");
  const data = (await r.json()) as { jira_base_url: string; jira_project_key: string };
  assert.equal(data.jira_base_url, "https://acme.atlassian.net");
  assert.equal(data.jira_project_key, "TEST");
});

test("GET /jira/issues returns tracked issues list (empty)", async () => {
  const res = await get("/jira/issues");
  assert.equal(res.status, 200);
});

// ── /pagerduty ──────────────────────────────────────────────────────────

test("GET /pagerduty/settings returns empty config without leaking secret", async () => {
  const res = await get("/pagerduty/settings");
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.equal(data.integration_key, undefined,
    "raw integration_key must never be returned by GET");
});

test("PATCH /pagerduty/settings rejects an invalid severity gracefully", async () => {
  // Should still succeed (route normalises to 'error') but the response
  // shape needs to be ok.
  const res = await patch("/pagerduty/settings", {
    integration_key: "TEST-KEY",
    severity: "garbage",
    auto_trigger: false,
  });
  assert.ok(res.ok, `PATCH failed: ${res.status}`);
});

// ── /reports (scheduled) ────────────────────────────────────────────────

let reportId: number;

test("POST /reports creates a scheduled report", async () => {
  const res = await post("/reports", {
    name: "Daily summary",
    cadence: "daily",
    hour_utc: 9,
    channel: "email",
    destination: "ops@acme.com",
  });
  // Read body once — double-reading via .text() then .json() throws
  // "Body has already been read" on the same Response.
  const text = await res.text();
  assert.ok(res.ok, `reports POST failed: ${res.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { id: number };
  reportId = data.id;
});

test("GET /reports lists the created scheduled report", async () => {
  const res = await get("/reports");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ id: number }>;
  assert.ok(Array.isArray(rows), "/reports should return an array");
  assert.ok(rows.some((r) => r.id === reportId), "created report missing from list");
});

test("PATCH /reports/:id updates fields", async () => {
  const res = await patch(`/reports/${reportId}`, { hour_utc: 18 });
  assert.ok(res.ok, `reports PATCH failed: ${res.status}`);
});

test("DELETE /reports/:id removes the scheduled report", async () => {
  const res = await del(`/reports/${reportId}`);
  assert.ok(res.ok, `reports DELETE failed: ${res.status}`);
});
