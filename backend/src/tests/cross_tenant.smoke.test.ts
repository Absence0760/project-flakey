/**
 * Cross-tenant RLS isolation + 4xx validation smoke tests.
 *
 * The big invariant of this codebase: two organizations CANNOT see or
 * mutate each other's data. The phase_9_10 file covers the happy path
 * but never exercises this; one regression there is a data leak.
 *
 * Run alongside phase_9_10.smoke.test.ts — they each spawn their own
 * server on a different port so `node --test`'s default parallelism
 * doesn't collide.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

interface OrgCtx {
  email: string;
  token: string;
  runId: number;
}

let orgA: OrgCtx;
let orgB: OrgCtx;

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

async function registerOrg(label: string): Promise<{ email: string; token: string }> {
  // Date.now() + label keeps the email unique across both orgs and re-runs.
  const email = `cross+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `Tenant-${label}`,
      org_name: `Org-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`register ${label} failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { token: string };
  return { email, token: data.token };
}

async function uploadRunForOrg(token: string, suite: string): Promise<number> {
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suite,
        branch: "main",
        commit_sha: `sha-${suite}`,
        ci_run_id: `ci-${suite}-${Date.now()}`,
        started_at: "2026-04-10T00:00:00Z",
        finished_at: "2026-04-10T00:00:10Z",
        reporter: "mochawesome",
      },
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 10000 },
      specs: [
        {
          file_path: "a.js",
          title: "a",
          stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 10 },
          tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 10, screenshot_paths: [] }],
        },
      ],
    })
  );
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`run upload failed: ${res.status} ${body}`);
  }
  return ((await res.json()) as { id: number }).id;
}

function asAuth(token: string) {
  return {
    get: (path: string) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    post: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
  };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      // RLS bypass-check: connect as flakey_app (NOT the superuser
      // 'flakey'), matching production.  If this is changed to 'flakey'
      // every RLS test in this file becomes a no-op because superusers
      // bypass row-level security.
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "cross-tenant-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Long enough that nothing in this file trips the stale-run timer.
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const a = await registerOrg("a");
  const b = await registerOrg("b");
  const runA = await uploadRunForOrg(a.token, "tenant-a-suite");
  const runB = await uploadRunForOrg(b.token, "tenant-b-suite");
  orgA = { ...a, runId: runA };
  orgB = { ...b, runId: runB };

  // Sanity: each org's run has a different id (otherwise the rest of this
  // file silently passes by accident).
  assert.notEqual(orgA.runId, orgB.runId, "the two orgs should have distinct run ids");
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── RLS: read isolation ──────────────────────────────────────────────────

test("GET /runs as org B does not list org A's runs", async () => {
  const res = await asAuth(orgB.token).get("/runs");
  assert.equal(res.status, 200);
  const runs = (await res.json()) as Array<{ id: number; suite_name: string }>;
  // The /runs response is wrapped on some routes — handle both shapes.
  const list = Array.isArray(runs) ? runs : (runs as { runs?: Array<{ id: number }> }).runs ?? [];
  assert.ok(
    !list.some((r) => r.id === orgA.runId),
    `org B should not see org A's run #${orgA.runId} in its /runs response`
  );
  assert.ok(list.some((r) => r.id === orgB.runId), "org B should see its own run");
});

test("GET /runs/:id 404s when the run belongs to another org", async () => {
  const res = await asAuth(orgB.token).get(`/runs/${orgA.runId}`);
  assert.equal(res.status, 404, "RLS leak: org B got a 200 reading org A's run");
});

test("GET /coverage/runs/:runId 404s across the org boundary", async () => {
  // Plant coverage on org A's run so there's something to leak.
  const ok = await asAuth(orgA.token).post("/coverage", { run_id: orgA.runId, lines_pct: 91.5 });
  assert.equal(ok.status, 201);

  const cross = await asAuth(orgB.token).get(`/coverage/runs/${orgA.runId}`);
  assert.equal(cross.status, 404, "RLS leak: org B read org A's coverage");
});

test("GET /security/runs/:runId returns empty across the org boundary", async () => {
  // Plant security findings on org A's run.
  const ok = await asAuth(orgA.token).post("/security", {
    run_id: orgA.runId,
    scanner: "zap",
    findings: [{ name: "leak-canary-finding", severity: "high" }],
  });
  assert.equal(ok.status, 201);

  // Sanity: org A sees its own findings.
  const own = await asAuth(orgA.token).get(`/security/runs/${orgA.runId}`);
  const ownData = (await own.json()) as Array<{ findings: unknown[] }>;
  assert.equal(ownData.length, 1);
  assert.equal(ownData[0].findings.length, 1);

  // RLS: org B reading the same run id sees nothing (RLS filters the rows
  // out at the DB layer, so the response is an empty array, not a 404).
  const cross = await asAuth(orgB.token).get(`/security/runs/${orgA.runId}`);
  assert.equal(cross.status, 200);
  const crossData = (await cross.json()) as unknown[];
  assert.equal(crossData.length, 0, "RLS leak: org B saw org A's security scans");
});

test("GET /a11y/runs/:runId returns empty across the org boundary", async () => {
  const ok = await asAuth(orgA.token).post("/a11y", {
    run_id: orgA.runId,
    url: "/secret",
    violations: [{ id: "leaked", impact: "critical" }],
  });
  assert.equal(ok.status, 201);

  const cross = await asAuth(orgB.token).get(`/a11y/runs/${orgA.runId}`);
  assert.equal(cross.status, 200);
  const data = (await cross.json()) as unknown[];
  assert.equal(data.length, 0, "RLS leak: org B saw org A's a11y reports");
});

// ── RLS: write isolation ─────────────────────────────────────────────────

test("POST /coverage cannot target another org's run (404, not created)", async () => {
  const res = await asAuth(orgB.token).post("/coverage", {
    run_id: orgA.runId,
    lines_pct: 0.1,
  });
  assert.equal(res.status, 404, "RLS leak: org B was allowed to POST coverage onto org A's run");

  // And the original coverage row on A's run is unchanged.
  const own = await asAuth(orgA.token).get(`/coverage/runs/${orgA.runId}`);
  assert.equal(own.status, 200);
  const data = (await own.json()) as { lines_pct: string };
  assert.equal(parseFloat(data.lines_pct), 91.5, "org A's coverage was overwritten by a cross-org POST");
});

test("POST /security cannot target another org's run (404, no findings created)", async () => {
  const res = await asAuth(orgB.token).post("/security", {
    run_id: orgA.runId,
    scanner: "zap",
    findings: [{ name: "should-not-land", severity: "high" }],
  });
  assert.equal(res.status, 404, "RLS leak: org B was allowed to POST security onto org A's run");

  // A's findings are still just the one canary from earlier.
  const own = await asAuth(orgA.token).get(`/security/runs/${orgA.runId}`);
  const data = (await own.json()) as Array<{ findings: Array<{ name: string }> }>;
  assert.equal(data[0].findings.length, 1);
  assert.equal(data[0].findings[0].name, "leak-canary-finding");
});

test("POST /a11y cannot target another org's run", async () => {
  const res = await asAuth(orgB.token).post("/a11y", {
    run_id: orgA.runId,
    url: "/should-not-land",
    violations: [],
  });
  assert.equal(res.status, 404, "RLS leak: org B was allowed to POST a11y onto org A's run");
});

// ── Auth boundary ───────────────────────────────────────────────────────

test("authenticated routes return 401 without a token", async () => {
  // Sample one route from each major area; if these all enforce auth, the
  // global `requireAuth` middleware is wired correctly.
  const routes = [
    "/runs",
    "/coverage/runs/1",
    "/security/runs/1",
    "/a11y/runs/1",
    "/visual/runs/1",
    "/jira/settings",
    "/pagerduty/settings",
    "/manual-tests",
    "/releases",
  ];
  for (const path of routes) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(
      res.status,
      401,
      `expected 401 for unauthenticated ${path}, got ${res.status} (auth middleware not wired?)`
    );
  }
});

test("authenticated routes return 401 with a malformed bearer token", async () => {
  const res = await fetch(`${BASE}/runs`, {
    headers: { Authorization: "Bearer not-a-real-jwt" },
  });
  assert.equal(res.status, 401);
});

// ── 4xx validation paths on the new endpoints ────────────────────────────

test("POST /coverage rejects missing run_id with 400", async () => {
  const res = await asAuth(orgA.token).post("/coverage", { lines_pct: 50 });
  assert.equal(res.status, 400);
});

test("POST /coverage 404s on a nonexistent run id", async () => {
  // The run id 999999 won't exist in the test DB; a 500 here would mean the
  // route doesn't distinguish "not found" from "broken query".
  const res = await asAuth(orgA.token).post("/coverage", { run_id: 999999, lines_pct: 50 });
  assert.equal(res.status, 404);
});

test("POST /security rejects missing run_id with 400", async () => {
  const res = await asAuth(orgA.token).post("/security", { scanner: "zap", findings: [] });
  assert.equal(res.status, 400);
});

test("POST /security rejects missing/blank scanner with 400", async () => {
  const blank = await asAuth(orgA.token).post("/security", { run_id: orgA.runId, scanner: "  ", findings: [] });
  assert.equal(blank.status, 400, "blank scanner string should be rejected");
  const missing = await asAuth(orgA.token).post("/security", { run_id: orgA.runId, findings: [] });
  assert.equal(missing.status, 400, "missing scanner field should be rejected");
});

test("POST /security normalizes risk-label aliases into the four severity buckets", async () => {
  const res = await asAuth(orgA.token).post("/security", {
    run_id: orgA.runId,
    scanner: "alias-test",
    findings: [
      { name: "f-crit", severity: "Critical" }, // → high
      { name: "f-warn", severity: "warning" }, // → medium
      { name: "f-mod", severity: "Moderate" }, // → medium
      { name: "f-info", severity: "Informational" }, // → info
      { name: "f-note", severity: "note" }, // → info
      { name: "f-junk", severity: "purple" }, // unknown → info
    ],
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { high_count: number; medium_count: number; low_count: number; info_count: number };
  assert.equal(data.high_count, 1, "Critical → high");
  assert.equal(data.medium_count, 2, "warning + Moderate → medium");
  assert.equal(data.low_count, 0);
  assert.equal(data.info_count, 3, "Informational + note + unknown → info");
});

test("POST /security with empty findings still creates a scan row with all zeros", async () => {
  const res = await asAuth(orgA.token).post("/security", {
    run_id: orgA.runId,
    scanner: "empty-test",
    findings: [],
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as {
    high_count: number;
    medium_count: number;
    low_count: number;
    info_count: number;
    findings: number;
  };
  assert.equal(data.findings, 0);
  assert.equal(data.high_count + data.medium_count + data.low_count + data.info_count, 0);
});

test("POST /security clamps non-positive instances to 1", async () => {
  const res = await asAuth(orgA.token).post("/security", {
    run_id: orgA.runId,
    scanner: "instance-test",
    findings: [
      { name: "zero", severity: "low", instances: 0 },
      { name: "neg", severity: "low", instances: -5 },
      { name: "frac", severity: "low", instances: 2.7 },
    ],
  });
  assert.equal(res.status, 201);

  const list = await asAuth(orgA.token).get(`/security/runs/${orgA.runId}`);
  const scans = (await list.json()) as Array<{ scanner: string; findings: Array<{ name: string; instances: number }> }>;
  const scan = scans.find((s) => s.scanner === "instance-test")!;
  const byName = Object.fromEntries(scan.findings.map((f) => [f.name, f.instances]));
  assert.equal(byName.zero, 1, "instances=0 should clamp to 1");
  assert.equal(byName.neg, 1, "negative instances should clamp to 1");
  assert.equal(byName.frac, 2, "fractional instances should floor");
});
