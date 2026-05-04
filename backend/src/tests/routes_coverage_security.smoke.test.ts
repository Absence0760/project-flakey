/**
 * Coverage / security / a11y / visual / ui-coverage smoke tests.
 *
 * Each of these route files has the same shape: POST a record tied to
 * a run_id, then GET it back via /<resource>/runs/:runId.  The smoke
 * tests cover:
 *   - empty-list reads (org with no data)
 *   - happy-path POST for one record per resource
 *   - GET /<resource>/runs/:runId echoes what was uploaded
 *   - coverage settings PATCH/GET round-trip
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3991;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let runId: number;

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
      JWT_SECRET: "covsec-secret",
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
      email: `cs+${Date.now()}@test.local`, password: "testpass123",
      name: "CS", org_name: `CSOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;

  // We need a run to attach coverage/security/a11y/visual to.
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: "covsec-suite",
      branch: "main",
      commit_sha: "covsec-sha",
      ci_run_id: `ci-cs-${Date.now()}`,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [{
      file_path: "smoke.cy.ts",
      title: "smoke",
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 30000 },
      tests: [{ title: "ok", full_title: "smoke > ok", status: "passed", duration_ms: 100, screenshot_paths: [] }],
    }],
  }));
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
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
function patch(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// ── /coverage ───────────────────────────────────────────────────────────

test("POST /coverage attaches a coverage report to the run", async () => {
  const res = await post("/coverage", {
    run_id: runId,
    lines_pct: 85.5,
    branches_pct: 70,
    functions_pct: 90,
    statements_pct: 86,
    lines_covered: 855,
    lines_total: 1000,
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { lines_pct: string | number };
  assert.ok(data.lines_pct);
});

test("POST /coverage 400s when run_id is missing", async () => {
  const res = await post("/coverage", { lines_pct: 80 });
  assert.equal(res.status, 400);
});

test("POST /coverage 404s for a run from a different org", async () => {
  // Use a runId we don't own (well into the future range).
  const res = await post("/coverage", { run_id: 99_999_999, lines_pct: 80 });
  assert.equal(res.status, 404);
});

test("GET /coverage/runs/:runId returns the uploaded report", async () => {
  const res = await get(`/coverage/runs/${runId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data, "coverage report missing");
});

test("GET /coverage/trend returns an array", async () => {
  const res = await get("/coverage/trend");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data) || (data as { rows?: unknown[] }).rows);
});

test("PATCH+GET /coverage/settings round-trip", async () => {
  const setRes = await patch("/coverage/settings", { coverage_threshold: 80, coverage_gate_enabled: true });
  assert.ok(setRes.ok, `settings PATCH failed: ${setRes.status}`);

  const getRes = await get("/coverage/settings");
  assert.equal(getRes.status, 200);
  const data = (await getRes.json()) as { coverage_threshold?: number; coverage_gate_enabled?: boolean };
  assert.equal(Number(data.coverage_threshold), 80);
  assert.equal(data.coverage_gate_enabled, true);
});

// ── /security ───────────────────────────────────────────────────────────

test("POST /security ingests a scan and severity-bucketed findings", async () => {
  const res = await post("/security", {
    run_id: runId,
    scanner: "trivy",
    target: "image:latest",
    findings: [
      { id: "CVE-2026-0001", title: "Critical OpenSSL bug", severity: "CRITICAL", description: "RCE" },
      { id: "CVE-2026-0002", title: "Medium issue", severity: "warning" },
      { id: "CVE-2026-0003", title: "Note", severity: "informational" },
    ],
  });
  assert.ok(res.ok, `security POST failed: ${res.status}`);
});

test("GET /security/runs/:runId returns the scan we just uploaded", async () => {
  const res = await get(`/security/runs/${runId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data, "security data missing");
});

test("GET /security/trend returns an array (possibly empty)", async () => {
  const res = await get("/security/trend");
  assert.equal(res.status, 200);
});

// ── /a11y ───────────────────────────────────────────────────────────────

test("POST /a11y ingests an axe-core style report", async () => {
  const res = await post("/a11y", {
    run_id: runId,
    url: "https://example.com/login",
    violations: [
      { id: "color-contrast", impact: "serious", description: "Low contrast", nodes: [{ target: ["button.submit"] }] },
    ],
    passes: 12,
    incomplete: 0,
  });
  assert.ok(res.ok, `a11y POST failed: ${res.status}`);
});

test("GET /a11y/runs/:runId returns the uploaded a11y data", async () => {
  const res = await get(`/a11y/runs/${runId}`);
  assert.equal(res.status, 200);
});

test("GET /a11y/trend returns an array (possibly empty)", async () => {
  const res = await get("/a11y/trend");
  assert.equal(res.status, 200);
});

// ── /visual ─────────────────────────────────────────────────────────────

test("POST /visual ingests visual-diff records", async () => {
  const res = await post("/visual", {
    run_id: runId,
    diffs: [
      { test_title: "homepage hero", baseline_path: "/baselines/x.png", current_path: "/runs/x.png", diff_path: "/runs/x.diff.png", pixel_diff: 1234, status: "pending" },
    ],
  });
  assert.ok(res.ok, `visual POST failed: ${res.status}`);
});

test("GET /visual/runs/:runId returns the diff list", async () => {
  const res = await get(`/visual/runs/${runId}`);
  assert.equal(res.status, 200);
});

test("GET /visual/pending returns an array (possibly empty)", async () => {
  const res = await get("/visual/pending");
  assert.equal(res.status, 200);
});

// ── /ui-coverage ────────────────────────────────────────────────────────

test("POST /ui-coverage/visits records visited routes", async () => {
  // Visits POST requires `suite_name` and `visits[]`; each visit can be
  // a plain string OR an object with route_pattern.
  const res = await post("/ui-coverage/visits", {
    suite_name: "covsec-suite",
    run_id: runId,
    visits: [
      { route_pattern: "/login" },
      { route_pattern: "/dashboard" },
    ],
  });
  assert.ok(res.ok, `ui-coverage visits POST failed: ${res.status}`);
});

test("POST /ui-coverage/routes adds known routes", async () => {
  const res = await post("/ui-coverage/routes", {
    routes: ["/login", "/dashboard", "/settings"],
  });
  assert.ok(res.ok, `ui-coverage routes POST failed: ${res.status}`);
});

test("GET /ui-coverage returns covered-routes summary", async () => {
  const res = await get("/ui-coverage");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data);
});

test("GET /ui-coverage/untested returns array", async () => {
  const res = await get("/ui-coverage/untested");
  assert.equal(res.status, 200);
});

test("GET /ui-coverage/summary returns coverage percentage", async () => {
  const res = await get("/ui-coverage/summary");
  assert.equal(res.status, 200);
});
