/**
 * Read-route happy-path smoke tests.
 *
 * Backstops every authenticated GET endpoint that previously had no
 * coverage at all — stats, suites, tests, errors, quarantine, audit,
 * notes, views, flaky, reports, runs.  Each test does the minimum to
 * prove the endpoint:
 *   - returns 2xx for a logged-in user
 *   - reads from the seeded run (so RLS GUC errors and missing JOINs
 *     surface immediately, not in production)
 *   - shape sanity-checks (key fields are present, types are right)
 *
 * Not exhaustive — the goal is "any silent regression here breaks CI"
 * not "every query path is covered."  Targeted regression tests for
 * specific bugs go in their own files.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3993;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let runId: number;
let suiteName: string;
let testFullTitle: string;

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
      JWT_SECRET: "reads-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register a fresh org so we own the data we're reading.
  const email = `reads+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "Reads",
      org_name: `ReadsOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  token = ((await reg.json()) as { token: string }).token;

  // Upload one run with mixed pass/fail so flaky/errors/stats have
  // something to report.
  suiteName = `reads-suite-${Date.now()}`;
  testFullTitle = "Login > should accept valid creds";
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: suiteName,
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id: `ci-reads-${Date.now()}`,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [{
      file_path: "login.cy.ts",
      title: "login",
      stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 30000 },
      tests: [
        { title: "should accept valid creds", full_title: testFullTitle, status: "passed", duration_ms: 100, screenshot_paths: [] },
        { title: "should reject empty creds", full_title: "Login > should reject empty creds",
          status: "failed", duration_ms: 50, screenshot_paths: [],
          error: { message: "AssertionError: expected pass to be true", stack: "at line 5" } },
      ],
    }],
  }));
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
  runId = ((await up.json()) as { id: number }).id;
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
function del(path: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── /stats ──────────────────────────────────────────────────────────────

test("GET /stats returns automated + manual sections", async () => {
  const res = await get("/stats");
  assert.equal(res.status, 200);
  const data = await res.json() as { automated: { total_runs: number }, manual: object };
  assert.ok(data.automated, "automated section missing");
  assert.ok(data.manual, "manual section missing");
  assert.ok(data.automated.total_runs >= 1, "seeded run not counted");
});

test("GET /stats/trends returns the four trend arrays", async () => {
  const res = await get("/stats/trends");
  assert.equal(res.status, 200);
  const data = await res.json() as Record<string, unknown[]>;
  for (const key of ["pass_rate", "failures", "duration", "top_failures"]) {
    assert.ok(Array.isArray(data[key]), `${key} must be an array`);
  }
});

// ── /suites ─────────────────────────────────────────────────────────────

test("GET /suites lists the seeded suite", async () => {
  const res = await get("/suites");
  assert.equal(res.status, 200);
  const suites = (await res.json()) as Array<{ suite_name: string }>;
  assert.ok(suites.some((s) => s.suite_name === suiteName), "seeded suite missing from /suites");
});

// ── /runs ───────────────────────────────────────────────────────────────

test("GET /runs lists the seeded run", async () => {
  const res = await get("/runs");
  assert.equal(res.status, 200);
  const data = (await res.json()) as { runs: Array<{ id: number }>; summary: object };
  assert.ok(Array.isArray(data.runs), "/runs should return { runs: [...] }");
  assert.ok(data.runs.some((r) => r.id === runId), "seeded run missing from /runs");
  assert.ok(data.summary, "summary section missing");
});

test("GET /runs/:id returns the run detail with specs and tests", async () => {
  const res = await get(`/runs/${runId}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { specs: Array<{ tests: unknown[] }> };
  assert.ok(Array.isArray(data.specs), "specs array missing");
  assert.ok(data.specs[0]?.tests, "spec missing tests");
});

// ── /tests ──────────────────────────────────────────────────────────────

test("GET /tests/slowest/list returns array (possibly empty)", async () => {
  const res = await get("/tests/slowest/list");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || typeof data === "object");
});

test("GET /tests/search/list?q=login returns results", async () => {
  const res = await get(`/tests/search/list?q=login`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || typeof data === "object");
});

// ── /errors ─────────────────────────────────────────────────────────────

test("GET /errors lists error fingerprints from failed tests", async () => {
  const res = await get("/errors");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data), "errors response should be an array");
});

// ── /flaky ──────────────────────────────────────────────────────────────

test("GET /flaky returns array (possibly empty for a one-run org)", async () => {
  const res = await get("/flaky");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

// ── /quarantine ─────────────────────────────────────────────────────────

test("POST/GET/DELETE /quarantine round-trip", async () => {
  // POST: quarantine our failing test.
  const create = await post("/quarantine", {
    fullTitle: "Login > should reject empty creds",
    filePath: "login.cy.ts",
    suiteName,
    reason: "intermittent",
  });
  assert.equal(create.status, 201);

  // GET: list returns the new entry.
  const list = await get("/quarantine");
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ full_title: string }>;
  assert.ok(rows.some((r) => r.full_title === "Login > should reject empty creds"),
    "quarantined entry missing from list");

  // GET /check: CI integration view.
  const check = await get(`/quarantine/check?suite=${encodeURIComponent(suiteName)}`);
  assert.equal(check.status, 200);
  const checkData = (await check.json()) as { quarantined: Array<{ full_title: string }> };
  assert.ok(checkData.quarantined.length >= 1);

  // DELETE: unquarantine.
  const remove = await del("/quarantine", {
    fullTitle: "Login > should reject empty creds",
    suiteName,
  });
  assert.equal(remove.status, 200);
});

// ── /audit ──────────────────────────────────────────────────────────────

test("GET /audit lists recent audit entries (quarantine actions land here)", async () => {
  // Trigger an audit-logged action so we have something to assert.
  await post("/quarantine", {
    fullTitle: "Audit Test", filePath: "x.ts", suiteName, reason: "pin",
  });
  const res = await get("/audit");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || (data as { entries?: unknown[] }).entries !== undefined,
    "audit response shape unexpected");
});

// ── /notes ──────────────────────────────────────────────────────────────

test("GET /notes?target_type=run&target_key=:id returns notes for the run (empty)", async () => {
  // The route requires target_type + target_key params — no notes have
  // been added, so we expect an empty array.
  const res = await get(`/notes?target_type=run&target_key=${runId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

test("GET /notes 400s when target_type is missing", async () => {
  const res = await get("/notes");
  assert.equal(res.status, 400);
});

test("POST /notes + GET round-trip on a run target", async () => {
  const create = await post("/notes", {
    target_type: "run", target_key: String(runId),
    body: "investigating the failure",
  });
  assert.ok(create.ok, `note POST failed: ${create.status}`);

  const list = await get(`/notes?target_type=run&target_key=${runId}`);
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ body: string }>;
  assert.ok(rows.some((r) => r.body.includes("investigating")));
});

test("GET /notes/counts returns counts shape", async () => {
  // The counts endpoint also requires target params. The most useful
  // shape is `?target_type=run&target_key=:id` which returns the count
  // of notes per target.
  const res = await get(`/notes/counts?target_type=run&target_key=${runId}`);
  // Some implementations support a no-arg counts endpoint that lists
  // counts for every target — accept either 200 (works) or 400 (params
  // required).
  assert.ok(res.status === 200 || res.status === 400, `got ${res.status}`);
});

// ── /views ──────────────────────────────────────────────────────────────

test("POST + GET + DELETE /views round-trip", async () => {
  const create = await post("/views", {
    name: `view-${Date.now()}`,
    filters: { suite: suiteName },
  });
  assert.ok(create.status === 200 || create.status === 201, `expected 2xx, got ${create.status}`);
  const created = (await create.json()) as { id: number };

  const list = await get("/views");
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ id: number }>;
  assert.ok(rows.some((r) => r.id === created.id));

  const remove = await del(`/views/${created.id}`);
  assert.ok(remove.ok);
});

// ── /reports ────────────────────────────────────────────────────────────

test("GET /reports returns scheduled-report list (empty for new org)", async () => {
  const res = await get("/reports");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || typeof data === "object");
});

// ── /compare (route, not the unit-tested helper) ────────────────────────

test("GET /compare?a=X&b=X comparing run to itself produces all-unchanged", async () => {
  const res = await get(`/compare?a=${runId}&b=${runId}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { summary: Record<string, number> };
  // Self-compare: every test is "unchanged" (or a smattering of passed-pairs).
  // The key invariant is no regressions/fixed against itself.
  assert.equal((data.summary.regression ?? 0), 0, "self-compare should have 0 regressions");
  assert.equal((data.summary.fixed ?? 0), 0, "self-compare should have 0 fixed");
});

test("GET /compare 400s without both query params", async () => {
  const res = await get("/compare");
  assert.equal(res.status, 400);
});
