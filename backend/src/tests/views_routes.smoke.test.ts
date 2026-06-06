/**
 * Saved-views route smoke tests.
 *
 * Protects the real client workflow: a user saves a filtered view, lists
 * their views scoped to a page, and deletes stale ones. Filters persist as
 * a JSON object (the `filters` column is JSONB), not a stringified blob.
 *
 * routes_reads.smoke.test.ts already covers a basic POST/GET/DELETE
 * round-trip and cross_tenant covers RLS, so this file deliberately does
 * NOT re-prove those. It adds:
 *   - filters round-trip back as a JSON object (not a string)
 *   - page scoping: ?page=runs returns a runs view, ?page=tests does not
 *   - POST without a name → 400 with the documented message
 *   - default page when `page` is omitted matches the source default ('runs')
 *   - DELETE of a non-existent id → 404
 *
 * Each test creates its own org/data so assertions don't depend on seed
 * specifics or other agents sharing this DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3954;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

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

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "views-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register a fresh org so we own the views we create.
  const email = `views+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "Views",
      org_name: `ViewsOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
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
function del(path: string) {
  return fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

type View = {
  id: number;
  name: string;
  page: string;
  filters: Record<string, unknown>;
  created_at: string;
};

// ── filters round-trip as a JSON object ───────────────────────────────────

test("POST /views then GET returns filters as a JSON object, not a string", async () => {
  const name = `filters-view-${Date.now()}`;
  const filters = { suite: "checkout", branch: "main", status: ["failed", "flaky"], minDuration: 250 };

  const create = await post("/views", { name, page: "runs", filters });
  assert.equal(create.status, 201, "POST /views should return 201");
  const created = (await create.json()) as View;
  // The INSERT ... RETURNING already gives back the parsed JSONB column.
  assert.equal(typeof created.filters, "object", "filters should be an object on create, not a string");
  assert.deepEqual(created.filters, filters, "created filters should match what we sent");

  const list = await get("/views");
  assert.equal(list.status, 200);
  const rows = (await list.json()) as View[];
  const mine = rows.find((r) => r.id === created.id);
  assert.ok(mine, "created view missing from GET /views");
  assert.equal(typeof mine.filters, "object", "filters must come back as an object, not a stringified blob");
  assert.notEqual(typeof mine.filters, "string", "filters must not be a JSON string");
  assert.deepEqual(mine.filters, filters, "filters should survive the round-trip intact");
});

// ── page scoping ──────────────────────────────────────────────────────────

test("GET /views?page=X scopes to that page", async () => {
  const runsName = `runs-scoped-${Date.now()}`;
  const create = await post("/views", { name: runsName, page: "runs", filters: { kind: "runs" } });
  assert.equal(create.status, 201);
  const created = (await create.json()) as View;
  assert.equal(created.page, "runs");

  // ?page=runs must include the runs-scoped view.
  const runsList = await get("/views?page=runs");
  assert.equal(runsList.status, 200);
  const runsRows = (await runsList.json()) as View[];
  assert.ok(runsRows.some((r) => r.id === created.id), "?page=runs should return the runs-scoped view");
  assert.ok(runsRows.every((r) => r.page === "runs"), "?page=runs must only return page='runs' views");

  // ?page=tests must NOT include the runs-scoped view.
  const testsList = await get("/views?page=tests");
  assert.equal(testsList.status, 200);
  const testsRows = (await testsList.json()) as View[];
  assert.ok(!testsRows.some((r) => r.id === created.id), "?page=tests must not return a runs-scoped view");
});

// ── validation + default page ──────────────────────────────────────────────

test("POST /views without a name → 400 with the documented message", async () => {
  const res = await post("/views", { page: "runs", filters: { a: 1 } });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Name is required");
});

test("POST /views with page omitted defaults to 'runs'", async () => {
  const name = `default-page-${Date.now()}`;
  const create = await post("/views", { name, filters: { just: "filters" } });
  assert.equal(create.status, 201);
  const created = (await create.json()) as View;
  assert.equal(created.page, "runs", "omitted page should default to 'runs' (source default)");
});

// ── delete a non-existent view ───────────────────────────────────────────

test("DELETE /views/:id for a non-existent id → 404", async () => {
  // Use an id far above anything this fresh org could have created.
  const res = await del("/views/999999999");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "View not found");
});
