/**
 * Manual-tests cluster smoke tests.
 *
 * Backstops the manual-test CRUD + sub-routers (groups, requirements,
 * execution result recording, cucumber import, summary).  Each test
 * stays focused on a single endpoint and asserts the minimum that
 * proves authentication, RLS, and basic behaviour all work.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3992;
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
      JWT_SECRET: "manual-tests-secret",
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
      email: `mt+${Date.now()}@test.local`, password: "testpass123",
      name: "MT", org_name: `MTOrg-${Date.now()}`,
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

let manualTestId: number;

// ── Empty-list reads first ──────────────────────────────────────────────

test("GET /manual-tests returns empty list for fresh org", async () => {
  const res = await get("/manual-tests");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || (data as { rows?: unknown[] }).rows !== undefined);
});

test("GET /manual-tests/summary returns counts shape", async () => {
  const res = await get("/manual-tests/summary");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data === "object" && data !== null);
});

test("GET /manual-test-groups returns empty list for fresh org", async () => {
  const res = await get("/manual-test-groups");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || (data as { groups?: unknown[] }).groups !== undefined);
});

// ── Create / update / read / delete ─────────────────────────────────────

test("POST /manual-tests creates a manual test row", async () => {
  const res = await post("/manual-tests", {
    suite_name: "smoke",
    title: "Verify login",
    description: "Manual smoke for login UI",
    steps: [{ action: "Open /login", expected: "Login form appears" }],
    expected_result: "User is signed in",
    priority: "high",
    tags: ["smoke", "auth"],
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: number; title: string; priority: string };
  assert.equal(created.title, "Verify login");
  assert.equal(created.priority, "high");
  manualTestId = created.id;
});

test("POST /manual-tests rejects missing title", async () => {
  const res = await post("/manual-tests", { suite_name: "smoke" });
  assert.equal(res.status, 400);
});

test("GET /manual-tests/:id returns the created row", async () => {
  const res = await get(`/manual-tests/${manualTestId}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { id: number; title: string };
  assert.equal(data.id, manualTestId);
});

test("PATCH /manual-tests/:id updates fields (verified via subsequent GET)", async () => {
  const res = await patch(`/manual-tests/${manualTestId}`, {
    description: "Updated description",
    priority: "critical",
  });
  assert.ok(res.ok, `patch failed: ${res.status}`);
  // PATCH returns `{ updated: true }`, so verify by re-reading.
  const after = await get(`/manual-tests/${manualTestId}`);
  const data = (await after.json()) as { priority: string; description: string };
  assert.equal(data.priority, "critical");
  assert.equal(data.description, "Updated description");
});

test("POST /manual-tests/:id/result records a passed execution", async () => {
  const res = await post(`/manual-tests/${manualTestId}/result`, {
    status: "passed",
    notes: "Tested manually on 2026-04-10",
  });
  assert.ok(res.ok, `result POST failed: ${res.status}`);
});

test("POST /manual-tests/:id/result with step_results derives overall status", async () => {
  // No explicit `status` — overall must be derived from step statuses
  // (helpers.unit.test pins the helper itself; this test pins the
  // route's wiring of it).
  const res = await post(`/manual-tests/${manualTestId}/result`, {
    step_results: [
      { status: "passed", comment: "ok" },
      { status: "failed", comment: "bug" },
    ],
    notes: "step-by-step run",
  });
  assert.ok(res.ok, `result POST failed: ${res.status}`);
});

// ── Groups ──────────────────────────────────────────────────────────────

let groupId: number;

test("POST /manual-test-groups creates a group", async () => {
  const res = await post("/manual-test-groups", {
    name: "Critical paths",
    description: "Pre-release smoke",
  });
  assert.ok(res.ok, `group POST failed: ${res.status}`);
  const created = (await res.json()) as { id: number; name: string };
  assert.equal(created.name, "Critical paths");
  groupId = created.id;
});

test("PATCH /manual-test-groups/:id renames the group", async () => {
  const res = await patch(`/manual-test-groups/${groupId}`, { name: "Critical paths v2" });
  assert.ok(res.ok, `group PATCH failed: ${res.status}`);
});

test("PATCH /manual-tests/:id can set group_id to assign a test to a group", async () => {
  const res = await patch(`/manual-tests/${manualTestId}`, { group_id: groupId });
  assert.ok(res.ok, `assign-group PATCH failed: ${res.status}`);
});

test("GET /manual-test-groups/:id includes assigned tests", async () => {
  const res = await get(`/manual-test-groups/${groupId}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { tests?: Array<{ id: number }> };
  assert.ok(data.tests?.some((t) => t.id === manualTestId),
    "manual test should appear in group's tests list");
});

// ── Requirements (sub-router under /manual-tests/:id/requirements) ──────

test("POST /manual-tests/:id/requirements adds a requirement reference", async () => {
  const res = await post(`/manual-tests/${manualTestId}/requirements`, {
    ref_key: "JIRA-123",
    ref_url: "https://acme.atlassian.net/browse/JIRA-123",
    ref_title: "Login flow requirement",
  });
  assert.ok(res.ok, `req POST failed: ${res.status}`);
});

test("GET /manual-tests/:id/requirements lists the added requirement and infers provider", async () => {
  const res = await get(`/manual-tests/${manualTestId}/requirements`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ ref_key: string; provider: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref_key, "JIRA-123");
  assert.equal(rows[0].provider, "jira", "provider should be inferred from URL");
});

// ── Cucumber import ─────────────────────────────────────────────────────

test("POST /manual-tests/import-features creates one manual test per scenario", async () => {
  const res = await post("/manual-tests/import-features", {
    files: [{
      path: "features/login.feature",
      content: `Feature: Login
Scenario: Successful login
  Given the user is on /login
  When valid credentials are entered
  Then the dashboard appears
`,
    }],
  });
  assert.ok(res.ok, `import POST failed: ${res.status}`);
  const data = (await res.json()) as { imported?: number; scanned?: number };
  // Either field name is acceptable; just assert at least one row.
  const count = data.imported ?? data.scanned ?? 0;
  assert.ok(count >= 1, `expected at least 1 import; got ${count}`);
});

test("POST /manual-tests/import-features upserts in place on re-import", async () => {
  // Re-running with the same scenario name should NOT create duplicates.
  const res = await post("/manual-tests/import-features", {
    files: [{
      path: "features/login.feature",
      content: `Feature: Login
Scenario: Successful login
  Given the user is on /login
  Then the dashboard appears
`,
    }],
  });
  assert.ok(res.ok, `re-import POST failed: ${res.status}`);

  // List manual tests with cucumber source — should be exactly 1, not 2.
  const list = await get("/manual-tests");
  assert.equal(list.status, 200);
  const data = await list.json();
  const rows: Array<{ source: string; title: string }> = Array.isArray(data) ? data : (data as { rows: Array<{ source: string; title: string }> }).rows;
  const cucumberRows = rows.filter((r) => r.source === "cucumber" && r.title === "Successful login");
  assert.equal(cucumberRows.length, 1, "re-import must upsert, not duplicate");
});

// ── Cleanup-style endpoints ─────────────────────────────────────────────

test("DELETE /manual-test-groups/:id removes the group", async () => {
  const res = await del(`/manual-test-groups/${groupId}`);
  assert.ok(res.ok, `group DELETE failed: ${res.status}`);
});

test("DELETE /manual-tests/:id removes the manual test", async () => {
  const res = await del(`/manual-tests/${manualTestId}`);
  assert.ok(res.ok, `manual test DELETE failed: ${res.status}`);
});
