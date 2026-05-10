// Cross-functional smoke — flows that exercise multiple subsystems
// wired together. Each existing test file covers ONE subsystem;
// the gaps these tests fill are the seams between subsystems where
// a regression in any of them silently breaks the contract:
//
//   1. Live → end-of-run upload merge. A reporter calls /live/start,
//      streams events for some tests, then the end-of-run reporter
//      posts a full /runs/upload payload with the same ci_run_id.
//      The upload must MERGE into the live row (same run id), not
//      create a duplicate. Tests from both phases must appear under
//      the same run detail.
//
//   2. Flaky detection cycle. Upload two runs of the same suite where
//      one test passes in run A and fails in run B. GET /flaky must
//      surface it with pass_count=1, fail_count=1, flaky_rate=50.
//      Exercises the upload → normalize → query pipeline end-to-end
//      for the headline feature.
//
//   3. Compare with a real regression. Two runs, one new failure
//      between them. /compare?a=A&b=B must report a `regression`
//      category entry. Catches a regression in the classifier OR in
//      the upload-time test-row layout.
//
//   4. DELETE /runs/:id cascade. Upload a run, delete it, verify
//      the row + all FK children are gone. Catches an ON DELETE
//      CASCADE that's been dropped from a migration.
//
//   5. /errors round-trip. Upload a failed test, list error
//      fingerprints, mark one as resolved, and verify the status
//      sticks. Errors are derived from runs via error_message
//      fingerprinting; the route is a thin layer over that pipeline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3978;
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

function auth() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type TestSpec = {
  title?: string;
  full_title?: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration_ms?: number;
  error?: string;
};

async function uploadRun(
  suite: string,
  ciRunId: string,
  testSpecs: TestSpec[],
): Promise<number> {
  const passed = testSpecs.filter((t) => t.status === "passed").length;
  const failed = testSpecs.filter((t) => t.status === "failed").length;
  const skipped = testSpecs.filter((t) => t.status === "skipped").length;
  const pending = testSpecs.filter((t) => t.status === "pending").length;
  const total = testSpecs.length;
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suite,
        branch: "main",
        commit_sha: `sha-${ciRunId}`,
        ci_run_id: ciRunId,
        started_at: "2026-05-10T00:00:00Z",
        finished_at: "2026-05-10T00:00:10Z",
        reporter: "mochawesome",
      },
      stats: { total, passed, failed, skipped, pending, duration_ms: 10000 },
      specs: [
        {
          file_path: `${suite}.cy.ts`,
          title: suite,
          stats: { total, passed, failed, skipped, duration_ms: 10000 },
          tests: testSpecs.map((t, i) => ({
            title: t.title ?? `t${i}`,
            full_title: t.full_title ?? t.title ?? `t${i}`,
            status: t.status,
            duration_ms: t.duration_ms ?? 10,
            // The upload route reads test.error?.message — pass the
            // error as a structured object, not a flat error_message
            // string.
            error: t.error ? { message: t.error } : null,
            screenshot_paths: [],
          })),
        },
      ],
    }),
  );
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/runs/upload failed: ${res.status} ${body}`);
  }
  return ((await res.json()) as { id: number }).id;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "cross-function-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
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
      email: `cross-fn+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Cross Fn",
      org_name: `CrossFnOrg-${Date.now()}`,
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

// ── 1. Live → upload merge ───────────────────────────────────────────

test("live-started run + /runs/upload sharing the same ci_run_id merge into a single run (id preserved, both phases' tests visible)", async () => {
  const suite = `live-merge-${Date.now()}`;
  const ciRunId = `ci-live-merge-${Date.now()}`;

  // 1. Start a live run with an explicit ci_run_id so the upload
  //    has something to merge against.
  const start = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ suite, ciRunId }),
  });
  assert.equal(start.status, 201);
  const liveRunId = ((await start.json()) as { id: number }).id;

  // 2. Stream a single test result through /live/events.
  await fetch(`${BASE}/live/${liveRunId}/events`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify([
      { type: "spec.started", spec: "live-spec.cy.ts" },
      { type: "test.passed", spec: "live-spec.cy.ts", test: "live-test", duration_ms: 50 },
    ]),
  });

  // Poll until the live test row materialises before triggering
  // the upload — /live/events processes events asynchronously
  // post-response, so a fire-and-forget upload could race ahead.
  const start1 = Date.now();
  while (Date.now() - start1 < 3000) {
    const r = await fetch(`${BASE}/runs/${liveRunId}`, { headers: auth() });
    const body = (await r.json()) as { specs: Array<{ tests: unknown[] }> };
    if (body.specs.length > 0 && body.specs[0].tests.length > 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }

  // 3. End-of-run /runs/upload with same suite + same ci_run_id.
  //    The findOrCreateRun upsert (run-merge.ts) must return the
  //    existing run id, not allocate a new one.
  const uploadedId = await uploadRun(suite, ciRunId, [
    { title: "upload-test", full_title: "upload-test", status: "passed", duration_ms: 50 },
  ]);
  assert.equal(
    uploadedId,
    liveRunId,
    "upload with matching ci_run_id must merge into the live run, not create a duplicate",
  );

  // 4. Both phases' tests must be visible on the merged run.
  const detail = await fetch(`${BASE}/runs/${liveRunId}`, { headers: auth() });
  const body = (await detail.json()) as { specs: Array<{ file_path: string; tests: Array<{ full_title: string }> }> };
  const allTitles = body.specs.flatMap((s) => s.tests.map((t) => t.full_title));
  assert.ok(allTitles.includes("live-test"), "live-streamed test row must survive the merge");
  assert.ok(allTitles.includes("upload-test"), "upload-side test row must be added by the merge");
});

// ── 2. Flaky detection cycle ─────────────────────────────────────────

test("two runs of the same suite with one test flipping pass/fail surface it in GET /flaky with the right counts", async () => {
  const suite = `flaky-cycle-${Date.now()}`;
  const fullTitle = "Login flow > should reject empty";

  // Run A: passes.
  await uploadRun(suite, `ci-flaky-A-${Date.now()}`, [
    { title: "Login flow > should reject empty", full_title: fullTitle, status: "passed" },
  ]);
  // Run B: same test fails.
  await uploadRun(suite, `ci-flaky-B-${Date.now()}`, [
    { title: "Login flow > should reject empty", full_title: fullTitle, status: "failed", error: "AssertionError: deliberate" },
  ]);

  const flaky = await fetch(`${BASE}/flaky?suite=${encodeURIComponent(suite)}`, { headers: auth() });
  assert.equal(flaky.status, 200);
  const list = (await flaky.json()) as Array<{
    full_title: string; pass_count: number; fail_count: number; flaky_rate: number;
  }>;
  const row = list.find((r) => r.full_title === fullTitle);
  assert.ok(row, "test that flipped pass/fail across two runs must appear in /flaky");
  assert.equal(row!.pass_count, 1, "pass_count must reflect the one passing run");
  assert.equal(row!.fail_count, 1, "fail_count must reflect the one failing run");
  assert.equal(row!.flaky_rate, 50, "flaky_rate must compute as fail_count / total_runs * 100");
});

// ── 3. Compare with a real regression ────────────────────────────────

test("GET /compare?a=A&b=B with a regressed test reports a 'regression' category entry", async () => {
  const suite = `compare-regress-${Date.now()}`;
  // Two tests in run A, both pass.
  const runA = await uploadRun(suite, `ci-cmp-A-${Date.now()}`, [
    { title: "t1", full_title: "t1", status: "passed" },
    { title: "t2", full_title: "t2", status: "passed" },
  ]);
  // Run B has the same two tests; t2 now fails.
  const runB = await uploadRun(suite, `ci-cmp-B-${Date.now()}`, [
    { title: "t1", full_title: "t1", status: "passed" },
    { title: "t2", full_title: "t2", status: "failed", error: "AssertionError: regression" },
  ]);

  const cmp = await fetch(`${BASE}/compare?a=${runA}&b=${runB}`, { headers: auth() });
  assert.equal(cmp.status, 200);
  const body = (await cmp.json()) as {
    summary: Record<string, number>;
    comparisons: Array<{ title: string; category: string }>;
  };
  // t2 must be classified `regression` (passed → failed). The
  // /compare response keys comparisons by file_path + leaf title,
  // not full_title — find by `title`.
  const regressed = body.comparisons.find((c) => c.title === "t2");
  assert.ok(regressed, "regressed test row must appear in /compare comparisons");
  assert.equal(
    regressed!.category,
    "regression",
    "passed→failed must classify as 'regression' — categorizeChange's regression branch must be active",
  );
  // The summary count must reflect the same row.
  assert.equal(body.summary.regression, 1, "summary.regression must equal the count of regression entries");
});

// ── 4. DELETE /runs/:id cascade ──────────────────────────────────────

test("DELETE /runs/:id 200s and the subsequent GET /runs/:id 404s (cascade to specs/tests is intact)", async () => {
  const runId = await uploadRun(`delete-cascade-${Date.now()}`, `ci-del-${Date.now()}`, [
    { title: "t1", full_title: "t1", status: "passed" },
  ]);

  const del = await fetch(`${BASE}/runs/${runId}`, {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(del.status, 200, "DELETE /runs/:id should succeed for an owner");

  const get = await fetch(`${BASE}/runs/${runId}`, { headers: auth() });
  assert.equal(get.status, 404, "GET /runs/:id after delete must 404 — the run is gone");

  // Try to delete again — must 404, not 500. ON DELETE CASCADE
  // means the specs/tests have gone with it; a 500 would mean
  // the cascade missed a row that's now FK-blocking the delete.
  const del2 = await fetch(`${BASE}/runs/${runId}`, {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(del2.status, 404, "second DELETE on a gone run must 404, not 500 — cascade must have cleaned everything");
});

// ── 5. /errors round-trip ─────────────────────────────────────────────

test("/errors lists fingerprints from failed tests and PATCH /errors/:fp/status persists the new status", async () => {
  const suite = `errors-rt-${Date.now()}`;
  const errMsg = `AssertionError: errors-rt unique ${Date.now()}`;
  await uploadRun(suite, `ci-err-${Date.now()}`, [
    { title: "tFail", full_title: "tFail", status: "failed", error: errMsg },
  ]);

  // GET /errors must surface a fingerprint whose error_message
  // is the one we just uploaded.
  const list = await fetch(`${BASE}/errors`, { headers: auth() });
  assert.equal(list.status, 200);
  const body = (await list.json()) as {
    errors: Array<{ fingerprint: string; error_message: string; status: string }>;
  } | Array<{ fingerprint: string; error_message: string; status: string }>;
  const rows = Array.isArray(body) ? body : body.errors;
  const ourRow = rows.find((r) => r.error_message?.includes("errors-rt unique"));
  assert.ok(ourRow, "an uploaded failed test must produce a fingerprint visible from GET /errors");
  // The default status for a new error must be 'open' (anything
  // else would mean the route is auto-resolving on creation).
  assert.equal(ourRow!.status, "open", "newly-uploaded error fingerprints must default to status='open'");

  // Mark it fixed; the new status must stick on the next list read.
  // The route's VALID_STATUSES are open / investigating / known /
  // fixed / ignored — pick one that's distinct from the default.
  const patch = await fetch(`${BASE}/errors/${ourRow!.fingerprint}/status`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ status: "fixed" }),
  });
  assert.equal(patch.status, 200);

  const after = await fetch(`${BASE}/errors`, { headers: auth() });
  const afterBody = (await after.json()) as
    | { errors: Array<{ fingerprint: string; status: string }> }
    | Array<{ fingerprint: string; status: string }>;
  const afterRows = Array.isArray(afterBody) ? afterBody : afterBody.errors;
  const updated = afterRows.find((r) => r.fingerprint === ourRow!.fingerprint);
  assert.equal(
    updated?.status,
    "fixed",
    "PATCH /errors/:fp/status must persist the new status — anything else means the route is a no-op or the read isn't joining error_groups for the status field",
  );
});
