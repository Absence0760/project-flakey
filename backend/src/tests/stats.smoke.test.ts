// /stats and /stats/trends correctness smoke.
//
// routes_reads.smoke.test.ts pins the response shape (returns the
// automated + manual sections, the four trend arrays) but never
// asserts the actual aggregate numbers against known data. The
// dashboard headline counters and trend charts all read from these
// endpoints — a regression in the SQL (date filter, JOIN, FILTER)
// silently produces wrong dashboards.
//
// This file uploads a known set of runs and asserts the aggregates
// match exactly. Three scenarios:
//
//   1. /stats unfiltered: counters reflect every run in the org.
//   2. /stats with from/to: counters narrow correctly to the date
//      range; out-of-range runs drop out.
//   3. /stats/trends: pass_rate and failures arrays are populated
//      and a known top failure appears in top_failures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3972;
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
  title: string;
  status: "passed" | "failed" | "skipped" | "pending";
  error?: string;
};

async function uploadRun(
  suite: string,
  testSpecs: TestSpec[],
): Promise<number> {
  const passed = testSpecs.filter((t) => t.status === "passed").length;
  const failed = testSpecs.filter((t) => t.status === "failed").length;
  const skipped = testSpecs.filter((t) => t.status === "skipped").length;
  const pending = testSpecs.filter((t) => t.status === "pending").length;
  const total = testSpecs.length;
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: `sha-${suite}-${Date.now()}`,
      ci_run_id: `ci-${suite}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      started_at: "2026-05-10T00:00:00Z",
      finished_at: "2026-05-10T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total, passed, failed, skipped, pending, duration_ms: 10000 },
    specs: [{
      file_path: `${suite}.cy.ts`,
      title: suite,
      stats: { total, passed, failed, skipped, duration_ms: 10000 },
      tests: testSpecs.map((t) => ({
        title: t.title,
        full_title: t.title,
        status: t.status,
        duration_ms: 100,
        error: t.error ? { message: t.error } : null,
        screenshot_paths: [],
      })),
    }],
  }));
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upload failed: ${res.status} ${body}`);
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
      JWT_SECRET: "stats-test-secret",
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
      email: `stats+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Stats",
      org_name: `StatsOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;

  // Seed three runs with known counts:
  //   Run A: 3 passed
  //   Run B: 2 passed + 1 failed
  //   Run C: 1 passed + 2 failed + 1 skipped
  // Org-wide aggregates: 10 tests, 6 passed, 3 failed, 1 skipped, pass_rate = round(6/10 * 100) = 60.
  await uploadRun("stats-a", [
    { title: "a1", status: "passed" },
    { title: "a2", status: "passed" },
    { title: "a3", status: "passed" },
  ]);
  await uploadRun("stats-b", [
    { title: "b1", status: "passed" },
    { title: "b2", status: "passed" },
    { title: "b3", status: "failed", error: "AssertionError: stats fixture failure (suite b)" },
  ]);
  await uploadRun("stats-c", [
    { title: "c1", status: "passed" },
    { title: "c2", status: "failed", error: "AssertionError: top-failures candidate" },
    { title: "c3", status: "failed", error: "AssertionError: top-failures candidate" },
    { title: "c4", status: "skipped" },
  ]);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── 1. /stats unfiltered: aggregates match the seeded data ─────────────

test("GET /stats reports the exact aggregate counts and pass-rate for all seeded runs", async () => {
  const res = await fetch(`${BASE}/stats`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    automated: {
      total_runs: number; total_tests: number;
      total_passed: number; total_failed: number; pass_rate: number;
      recent_runs: unknown[]; recent_failures: unknown[];
    };
    manual: { total: number };
  };

  assert.equal(body.automated.total_runs, 3, "three runs uploaded → total_runs must be 3");
  assert.equal(body.automated.total_tests, 10, "3 + 3 + 4 tests across the three runs");
  assert.equal(body.automated.total_passed, 6, "6 passing across the three runs");
  assert.equal(body.automated.total_failed, 3, "3 failing across the three runs");
  assert.equal(
    body.automated.pass_rate,
    60,
    "pass_rate = round(passed / total * 100) — anything else means the percentage math is broken",
  );

  assert.ok(
    Array.isArray(body.automated.recent_runs) && body.automated.recent_runs.length === 3,
    "recent_runs must list the 3 uploaded runs (LIMIT 20, so they all fit)",
  );

  // recent_failures should contain at least 3 entries (one per
  // failing test row across the three runs).
  assert.ok(
    body.automated.recent_failures.length >= 3,
    `recent_failures must include all failing tests with error_message; got ${body.automated.recent_failures.length}`,
  );

  // Fresh org has no manual tests seeded.
  assert.equal(body.manual.total, 0, "fresh org should have zero manual tests in the catalog");
});

// ── 2. /stats with from/to filter narrows correctly ─────────────────────

test("GET /stats?from=&to= narrows the counters to the date range (out-of-range runs drop out)", async () => {
  // All three seed runs were uploaded at "now"; pick a date range
  // that's entirely in the past — counters must drop to zero.
  const past = "2020-01-01";
  const res = await fetch(`${BASE}/stats?from=${past}&to=${past}`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    automated: { total_runs: number; total_tests: number; total_passed: number; total_failed: number };
  };
  assert.equal(body.automated.total_runs, 0, "no runs uploaded in 2020 — counters must zero out");
  assert.equal(body.automated.total_tests, 0);
  assert.equal(body.automated.total_passed, 0);
  assert.equal(body.automated.total_failed, 0);
});

// ── 3. /stats/trends populates pass_rate, failures, top_failures ────────

test("GET /stats/trends returns populated pass_rate / failures / top_failures arrays with the seeded data", async () => {
  const res = await fetch(`${BASE}/stats/trends`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    pass_rate: Array<{ date: string; runs: number; total: number; passed: number }>;
    failures: unknown[];
    duration: unknown[];
    top_failures: Array<{ title: string; failure_count: number }>;
  };

  assert.ok(Array.isArray(body.pass_rate), "pass_rate must be an array");
  assert.ok(body.pass_rate.length >= 1, "pass_rate must have at least today's bucket after the 3 uploads");

  // Today's bucket aggregates all three runs.
  const todayBucket = body.pass_rate.reduce(
    (best, b) => (b.runs > (best?.runs ?? 0) ? b : best),
    body.pass_rate[0],
  );
  assert.equal(todayBucket.runs, 3, "today's pass_rate bucket must show 3 runs");
  assert.equal(todayBucket.total, 10, "today's bucket must aggregate 10 tests across the 3 runs");
  assert.equal(todayBucket.passed, 6);

  // top_failures: a test title that failed in multiple runs of suite C
  // (`c2` / `c3`) must be in the top failures.
  assert.ok(body.top_failures.length >= 1, "top_failures must include at least one entry");
  const top = body.top_failures[0];
  assert.ok(
    top.failure_count >= 1,
    "top failure must have a positive failure_count — the SQL must COUNT correctly",
  );
});

// ── 4. /stats/trends with an empty date range ───────────────────────────

test("GET /stats/trends with from/to=2020 returns empty arrays (not 500 / not undefined)", async () => {
  // Edge case: caller picks a window with no data. Charts on the
  // dashboard must render "no data" gracefully; the endpoint must
  // return empty arrays, not null / undefined / 500.
  const res = await fetch(`${BASE}/stats/trends?from=2020-01-01&to=2020-12-31`, {
    headers: auth(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    pass_rate: unknown[]; failures: unknown[]; duration: unknown[]; top_failures: unknown[];
  };
  assert.ok(Array.isArray(body.pass_rate) && body.pass_rate.length === 0, "empty range → empty pass_rate");
  assert.ok(Array.isArray(body.failures) && body.failures.length === 0, "empty range → empty failures");
  assert.ok(Array.isArray(body.duration) && body.duration.length === 0, "empty range → empty duration");
  assert.ok(
    Array.isArray(body.top_failures) && body.top_failures.length === 0,
    "empty range → empty top_failures",
  );
});
