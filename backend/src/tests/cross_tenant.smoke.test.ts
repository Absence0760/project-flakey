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

// ── Run-upload input validation ─────────────────────────────────────────

test("POST /runs rejects payloads missing meta/stats/specs with 400", async () => {
  const res = await asAuth(orgA.token).post("/runs", {});
  assert.equal(res.status, 400, "empty body must be rejected with 400, not 500 or silent run creation");
});

test("POST /runs rejects partial payloads (meta only)", async () => {
  const res = await asAuth(orgA.token).post("/runs", {
    meta: { suite_name: "x", branch: "main", commit_sha: "", ci_run_id: "", started_at: "", finished_at: "", reporter: "mochawesome" },
  });
  assert.equal(res.status, 400);
});

test("POST /runs accepts well-formed minimal payload (no specs)", async () => {
  const res = await asAuth(orgA.token).post("/runs", {
    meta: {
      suite_name: `validation-${Date.now()}`,
      branch: "main",
      commit_sha: "",
      ci_run_id: `validation-ci-${Date.now()}`,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:01Z",
      reporter: "mochawesome",
    },
    stats: { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, duration_ms: 1 },
    specs: [],
  });
  // Empty specs list is legitimate (run setup that exits before any test) —
  // should land a run, just with no spec rows.
  assert.equal(res.status, 201);
});

// ── Live active-run enumeration ─────────────────────────────────────────

test("GET /live/active does not enumerate other orgs' active run ids", async () => {
  // /live/start emits run.started internally, which adds the run id to
  // the global activeRuns set inside liveEvents.  After that, any
  // authenticated user calling GET /live/active sees ALL active run
  // ids across the whole instance — an enumeration leak.
  const startRes = await asAuth(orgA.token).post("/live/start", {
    suite: "live-enum-suite",
    branch: "main",
  });
  assert.equal(startRes.status, 201);
  const startData = (await startRes.json()) as { id: number };

  // Sanity: org A sees its own run in active.
  const ownList = await asAuth(orgA.token).get("/live/active");
  const ownData = (await ownList.json()) as { runs: number[] };
  assert.ok(
    ownData.runs.includes(startData.id),
    "org A should see its own active run id; if this fails the test is mis-set-up"
  );

  // Org B fetches /live/active and must NOT see org A's run id.
  const list = await asAuth(orgB.token).get("/live/active");
  assert.equal(list.status, 200);
  const data = (await list.json()) as { runs: number[] };
  assert.ok(
    !data.runs.includes(startData.id),
    `org B's GET /live/active includes org A's live run id ${startData.id} — enumeration leak`
  );
});

// ── Live SSE stream ownership ────────────────────────────────────────────

test("GET /live/:runId/stream cannot subscribe to another org's run", async () => {
  // Without an org check on the SSE endpoint, anyone with a valid token
  // can connect to any run id and receive its live test events (test
  // titles, error messages, screenshots-via-events) — a cross-tenant
  // data leak through the live channel.
  //
  // Use AbortController to close the connection immediately after we
  // know the status code, otherwise the SSE response holds the
  // connection open indefinitely.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 500);
  try {
    const res = await fetch(`${BASE}/live/${orgA.runId}/stream`, {
      headers: { Authorization: `Bearer ${orgB.token}` },
      signal: ac.signal,
    });
    assert.equal(
      res.status,
      404,
      `cross-org SSE subscription must 404; got ${res.status}.  Without this check, org B can subscribe to org A's live stream just by knowing the run id.`
    );
    res.body?.cancel().catch(() => {});
  } catch (err: unknown) {
    // AbortError is ok IF we got status code first; otherwise it means
    // the server never closed the response, which is also a failure
    // (SSE connection remained open after auth check).
    if ((err as { name?: string })?.name !== "AbortError") throw err;
    throw new Error(
      "fetch was aborted before the server responded — the SSE endpoint accepts the cross-org request and holds it open"
    );
  } finally {
    clearTimeout(t);
  }
});

// ── Compare endpoint: both run ids must belong to caller's org ──────────

test("GET /compare with one cross-org run id returns 404", async () => {
  // The compare route fetches both runs via tenantQuery, so under RLS
  // the cross-org id should resolve to zero rows and trigger 404.  A
  // regression that joined runs without RLS scoping (or used pool.query)
  // would leak a diff between an attacker's run and a victim's run.
  const res = await asAuth(orgB.token).get(`/compare?a=${orgA.runId}&b=${orgB.runId}`);
  assert.equal(res.status, 404, "compare must 404 when one run id is from another org");
});

test("GET /compare with two same-org runs returns a diff", async () => {
  // Org A uploads a second run so we have two same-org ids to compare.
  const second = await uploadRunForOrg(orgA.token, "compare-second-suite");
  const res = await asAuth(orgA.token).get(`/compare?a=${orgA.runId}&b=${second}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { run_a: { id: number }; run_b: { id: number }; comparisons: unknown[] };
  assert.equal(data.run_a.id, orgA.runId);
  assert.equal(data.run_b.id, second);
});

// ── Quarantine cross-tenant ──────────────────────────────────────────────

test("POST /quarantine + GET /quarantine/check are scoped per-org", async () => {
  // Org A quarantines a test in a uniquely-named suite.
  const quarantineSuite = `quarantine-${Date.now()}`;
  const add = await asAuth(orgA.token).post("/quarantine", {
    fullTitle: "secret > flaky test",
    filePath: "secret.spec.ts",
    suiteName: quarantineSuite,
    reason: "intermittent timeout",
  });
  assert.equal(add.status, 201);

  // Org A sees it.
  const ownCheck = await asAuth(orgA.token).get(`/quarantine/check?suite=${quarantineSuite}`);
  const ownData = (await ownCheck.json()) as { quarantined: Array<{ full_title: string }> };
  assert.equal(ownData.quarantined.length, 1);

  // Org B querying the same suite name gets zero results.
  const crossCheck = await asAuth(orgB.token).get(`/quarantine/check?suite=${quarantineSuite}`);
  const crossData = (await crossCheck.json()) as { quarantined: Array<{ full_title: string }> };
  assert.equal(crossData.quarantined.length, 0, "RLS leak: org B sees org A's quarantined tests");

  const list = await asAuth(orgB.token).get("/quarantine");
  const allB = (await list.json()) as Array<{ suite_name: string }>;
  assert.ok(!allB.some((q) => q.suite_name === quarantineSuite),
    "RLS leak: org A's quarantined entry surfaced in org B's full list");
});

// ── Suite-level isolation ────────────────────────────────────────────────

test("PATCH /suites/:name/rename only affects the caller's org", async () => {
  // Both orgs upload a run under the same suite name.  Without RLS, a
  // rename done by org A could rename org B's suite too — a classic
  // multi-tenancy bug.
  const sharedSuite = `shared-${Date.now()}`;
  const aRun = await uploadRunForOrg(orgA.token, sharedSuite);
  const bRun = await uploadRunForOrg(orgB.token, sharedSuite);
  assert.ok(aRun !== bRun, "uploaded run ids should differ");

  // Org A renames the suite.
  const rename = await fetch(`${BASE}/suites/${encodeURIComponent(sharedSuite)}/rename`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgA.token}` },
    body: JSON.stringify({ new_name: `${sharedSuite}-renamed-by-a` }),
  });
  assert.equal(rename.status, 200);

  // Org B's suite should still be the original name (RLS confined the
  // UPDATE to org A's rows).
  const bSuites = await asAuth(orgB.token).get("/suites");
  const list = (await bSuites.json()) as Array<{ suite_name: string }>;
  assert.ok(list.some((s) => s.suite_name === sharedSuite),
    "org B's suite was renamed by org A — RLS leak in PATCH /suites/:name/rename");
  assert.ok(!list.some((s) => s.suite_name === `${sharedSuite}-renamed-by-a`),
    "org A's renamed suite name leaked into org B's listing");
});

test("DELETE /suites/:name as org A does not touch org B's runs", async () => {
  const sharedSuite = `delete-shared-${Date.now()}`;
  const aRun = await uploadRunForOrg(orgA.token, sharedSuite);
  const bRun = await uploadRunForOrg(orgB.token, sharedSuite);

  const del = await fetch(`${BASE}/suites/${encodeURIComponent(sharedSuite)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${orgA.token}` },
  });
  assert.equal(del.status, 200);

  // Org B's run with the same suite name still exists.
  const bRunRes = await asAuth(orgB.token).get(`/runs/${bRun}`);
  assert.equal(bRunRes.status, 200, "RLS leak: DELETE /suites cascaded into org B's runs");

  // Org A's run is gone.
  const aRunRes = await asAuth(orgA.token).get(`/runs/${aRun}`);
  assert.equal(aRunRes.status, 404, "org A's run was supposed to be deleted by suite delete");
});

// ── Run-merge concurrency (same ci_run_id from two workers) ──────────────

test("two run uploads with the same ci_run_id merge into a single run row", async () => {
  // The whole point of this product over Cypress Cloud is parallel-worker
  // merge.  Two workers POST runs with identical ci_run_id + suite — they
  // should land on the SAME run row, not two.
  const sharedCi = `merge-test-${Date.now()}`;
  const sharedSuite = `merge-suite-${Date.now()}`;

  const upload = (specFile: string) =>
    (() => {
      const fd = new FormData();
      fd.append(
        "payload",
        JSON.stringify({
          meta: {
            suite_name: sharedSuite,
            branch: "main",
            commit_sha: "merge-sha",
            ci_run_id: sharedCi,
            started_at: "2026-04-10T00:00:00Z",
            finished_at: "2026-04-10T00:00:10Z",
            reporter: "mochawesome",
          },
          stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 1000 },
          specs: [
            {
              file_path: specFile,
              title: specFile,
              stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 1000 },
              tests: [{ title: "t", full_title: `${specFile}>t`, status: "passed", duration_ms: 1000, screenshot_paths: [] }],
            },
          ],
        })
      );
      return fetch(`${BASE}/runs/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${orgA.token}` },
        body: fd,
      });
    })();

  // Sequential to avoid Postgres SERIALIZATION_FAILURE on concurrent
  // inserts to the same (ci_run_id, suite, org) — the two requests
  // should still merge.
  const r1 = await upload("worker1.js");
  assert.ok(r1.ok);
  const id1 = ((await r1.json()) as { id: number }).id;

  const r2 = await upload("worker2.js");
  assert.ok(r2.ok);
  const id2 = ((await r2.json()) as { id: number }).id;

  assert.equal(id1, id2, `two uploads with the same ci_run_id should merge — got ${id1} and ${id2}`);

  // The merged run should have BOTH specs.
  const detail = await asAuth(orgA.token).get(`/runs/${id1}`);
  const data = (await detail.json()) as { specs: Array<{ file_path: string }> };
  const files = data.specs.map((s) => s.file_path).sort();
  assert.deepEqual(
    files,
    ["worker1.js", "worker2.js"],
    "merged run should contain specs from both workers"
  );
});

// ── Integration settings + per-org records: encrypted secret isolation ──

test("Jira settings are isolated across orgs (no plaintext, no cross-read)", async () => {
  // Set a token for org A.
  const setA = await asAuth(orgA.token).post("/jira/settings", {
    base_url: "https://a.atlassian.net",
    email: "a@example.com",
    api_token: "TOKEN-A-EXFIL-CANARY",
    project_key: "QA",
  });
  // Note: settings update uses PATCH not POST in current code; the
  // wrapper above uses POST.  Use fetch directly with PATCH instead.
  if (setA.status !== 200) {
    const patch = await fetch(`${BASE}/jira/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgA.token}` },
      body: JSON.stringify({ base_url: "https://a.atlassian.net", email: "a@example.com", api_token: "TOKEN-A-EXFIL-CANARY", project_key: "QA" }),
    });
    assert.equal(patch.status, 200);
  }

  // Org B reads its own settings — must not see A's token, even encrypted.
  const getB = await asAuth(orgB.token).get("/jira/settings");
  assert.equal(getB.status, 200);
  const dataB = await getB.text();
  assert.ok(!dataB.includes("TOKEN-A-EXFIL-CANARY"), "RLS leak: org B saw org A's Jira token in plaintext");
  assert.ok(!dataB.includes("a.atlassian.net"), "RLS leak: org B saw org A's base_url");
  // B should see has_api_token=false (its own settings have no token).
  const parsedB = JSON.parse(dataB) as { has_api_token: boolean };
  assert.equal(parsedB.has_api_token, false, "org B's Jira settings polluted by org A's");
});

test("manual tests are isolated across orgs", async () => {
  // A creates a manual test.
  const create = await asAuth(orgA.token).post("/manual-tests", {
    suite_name: "tenant-a-suite",
    title: "Org A's secret manual test",
    steps: ["1. exfil canary"],
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number };

  // B lists — must not include A's test.
  const list = await asAuth(orgB.token).get("/manual-tests");
  const tests = (await list.json()) as Array<{ id: number; title: string }>;
  assert.ok(!tests.some((t) => t.id === created.id), "RLS leak: org B sees org A's manual tests");
  assert.ok(!tests.some((t) => t.title.includes("Org A's secret")), "manual test title leaked");

  // B GETs by id directly — must 404.
  const direct = await asAuth(orgB.token).get(`/manual-tests/${created.id}`);
  assert.equal(direct.status, 404, "RLS leak: org B fetched org A's manual test by id");
});

test("releases are isolated across orgs", async () => {
  // A creates a release.
  const create = await asAuth(orgA.token).post("/releases", {
    version: `v-orgA-${Date.now()}`,
    name: "Org A canary release",
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number };

  // B lists — must not include A's release.
  const list = await asAuth(orgB.token).get("/releases");
  const rels = (await list.json()) as Array<{ id: number; name: string | null }>;
  assert.ok(!rels.some((r) => r.id === created.id), "RLS leak: org B sees org A's releases");

  // B GET by id directly — must 404.
  const direct = await asAuth(orgB.token).get(`/releases/${created.id}`);
  assert.equal(direct.status, 404, "RLS leak: org B fetched org A's release by id");
});

test("saved views are isolated across orgs", async () => {
  // A saves a filter preset.
  const create = await asAuth(orgA.token).post("/views", {
    name: "Org A's view",
    filters: { suite: "tenant-a-suite", branch: "main" },
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number };

  const list = await asAuth(orgB.token).get("/views");
  const views = (await list.json()) as Array<{ id: number; name: string }>;
  assert.ok(!views.some((v) => v.id === created.id), "RLS leak: org B sees org A's saved views");
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
