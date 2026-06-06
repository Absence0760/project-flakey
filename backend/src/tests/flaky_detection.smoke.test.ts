/**
 * Flaky-detection smoke tests — protects the flaky dashboard workflow.
 *
 * The dashboard calls GET /flaky?suite=&runs=&limit= and reads, per row:
 *   - flaky_rate (fail_count / total_runs * 100, 1dp)
 *   - timeline   (status per run, oldest→newest)
 *   - flip_count (status transitions across the timeline)
 * plus three run-window / result truncation headers:
 *   - X-Flaky-Runs-Analyzed
 *   - X-Flaky-Run-Window-Truncated
 *   - X-Flaky-Results-Truncated
 *
 * Each test registers its OWN org and uploads its OWN runs, so assertions
 * never depend on seed data or other agents sharing this DB.  Runs are
 * uploaded sequentially (awaited) so runs.created_at — the only sort key
 * for the timeline (ORDER BY run_date ASC) — is strictly increasing and
 * the timeline order is deterministic.
 *
 * Route under test: src/routes/flaky.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3952;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry until healthy */
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
      JWT_SECRET: "flaky-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

/** Register a brand-new org and return its bearer token. */
async function registerOrg(label: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${label}+${stamp}@test.local`,
      password: "testpass123",
      name: label,
      org_name: `${label}-${stamp}`,
    }),
  });
  if (!reg.ok) {
    throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  }
  return ((await reg.json()) as { token: string }).token;
}

interface TestSpec {
  full_title: string;
  title: string;
  status: "passed" | "failed";
}

/**
 * Upload one run of a suite containing the given tests. Awaited fully so the
 * run's created_at advances strictly before the next upload — keeps the
 * timeline order deterministic.
 */
async function uploadRun(
  token: string,
  suiteName: string,
  tests: TestSpec[]
): Promise<number> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suiteName,
        branch: "main",
        commit_sha: stamp,
        ci_run_id: `ci-${suiteName}-${stamp}`,
        started_at: "2026-04-10T00:00:00Z",
        finished_at: "2026-04-10T00:00:30Z",
        reporter: "mochawesome",
      },
      stats: {
        total: tests.length,
        passed,
        failed,
        skipped: 0,
        pending: 0,
        duration_ms: 1000,
      },
      specs: [
        {
          file_path: `${suiteName}.cy.ts`,
          title: suiteName,
          stats: { total: tests.length, passed, failed, skipped: 0, duration_ms: 1000 },
          tests: tests.map((t) => ({
            title: t.title,
            full_title: t.full_title,
            status: t.status,
            duration_ms: 10,
            screenshot_paths: [],
            ...(t.status === "failed"
              ? { error: { message: "AssertionError: boom", stack: "at line 1" } }
              : {}),
          })),
        },
      ],
    })
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) {
    throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
  }
  return ((await up.json()) as { id: number }).id;
}

interface FlakyRow {
  full_title: string;
  suite_name: string;
  total_runs: number;
  pass_count: number;
  fail_count: number;
  timeline: string[];
  flip_count: number;
  flaky_rate: number;
}

async function getFlaky(
  token: string,
  query = ""
): Promise<{ rows: FlakyRow[]; res: Response }> {
  const res = await fetch(`${BASE}/flaky${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as FlakyRow[];
  return { rows, res };
}

// ── flip detection + timeline ───────────────────────────────────────────

test("test flipping fail→pass→fail surfaces as flaky with timeline + flip_count=2", async () => {
  const token = await registerOrg("flip");
  const suite = `flip-suite-${Date.now()}`;
  const fullTitle = "Checkout > should charge card";
  // Three sequential runs of the same test: failed, then passed, then failed.
  await uploadRun(token, suite, [{ full_title: fullTitle, title: "should charge card", status: "failed" }]);
  await uploadRun(token, suite, [{ full_title: fullTitle, title: "should charge card", status: "passed" }]);
  await uploadRun(token, suite, [{ full_title: fullTitle, title: "should charge card", status: "failed" }]);

  const { rows, res } = await getFlaky(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(res.status, 200);

  const row = rows.find((r) => r.full_title === fullTitle);
  assert.ok(row, "flipping test should surface as flaky");
  assert.deepEqual(row.timeline, ["failed", "passed", "failed"], "timeline must be oldest→newest");
  assert.equal(row.flip_count, 2, "two transitions: fail→pass, pass→fail");
  assert.equal(row.total_runs, 3);
  assert.equal(row.pass_count, 1);
  assert.equal(row.fail_count, 2);
});

// ── HAVING gate: needs BOTH a pass and a fail ─────────────────────────────

test("a test that only ever passed (or only failed) is NOT flaky", async () => {
  const token = await registerOrg("nonflaky");
  const suite = `nonflaky-suite-${Date.now()}`;
  const onlyPassed = "Stable > always green";
  const onlyFailed = "Broken > always red";
  // onlyPassed appears in run 1 only (passed); onlyFailed in run 2 only (failed).
  // Neither has both a pass and a fail, so the HAVING clause excludes both.
  await uploadRun(token, suite, [{ full_title: onlyPassed, title: "always green", status: "passed" }]);
  await uploadRun(token, suite, [{ full_title: onlyFailed, title: "always red", status: "failed" }]);
  // A third run that flips a different test, so the suite has SOME flaky output
  // and we know an empty result isn't just the whole query coming back blank.
  const flipper = "Mixed > sometimes fails";
  await uploadRun(token, suite, [{ full_title: flipper, title: "sometimes fails", status: "failed" }]);
  await uploadRun(token, suite, [{ full_title: flipper, title: "sometimes fails", status: "passed" }]);

  const { rows, res } = await getFlaky(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(res.status, 200);

  assert.ok(rows.some((r) => r.full_title === flipper), "the genuinely flaky test must surface");
  assert.ok(!rows.some((r) => r.full_title === onlyPassed), "an only-passed test is not flaky");
  assert.ok(!rows.some((r) => r.full_title === onlyFailed), "an only-failed test is not flaky");
});

// ── flaky_rate math + precision ──────────────────────────────────────────

test("flaky_rate = fail_count/total_runs*100 at 1dp (50.0% and 75.0%)", async () => {
  const token = await registerOrg("rate");
  const suite = `rate-suite-${Date.now()}`;
  const half = "Rate > two of four fail"; // 2 fails / 4 runs = 50.0
  const threeQ = "Rate > three of four fail"; // 3 fails / 4 runs = 75.0
  // Four runs; each carries both tests so both have total_runs=4.
  const seq: Array<[("passed" | "failed"), ("passed" | "failed")]> = [
    ["failed", "failed"],
    ["passed", "failed"],
    ["failed", "failed"],
    ["passed", "passed"],
  ];
  // half: failed,passed,failed,passed  -> 2 fail / 4
  // threeQ: failed,failed,failed,passed -> 3 fail / 4
  for (const [h, t] of seq) {
    await uploadRun(token, suite, [
      { full_title: half, title: "two of four fail", status: h },
      { full_title: threeQ, title: "three of four fail", status: t },
    ]);
  }

  const { rows, res } = await getFlaky(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(res.status, 200);

  const halfRow = rows.find((r) => r.full_title === half);
  const tqRow = rows.find((r) => r.full_title === threeQ);
  assert.ok(halfRow && tqRow, "both flaky tests should surface");

  assert.equal(halfRow.total_runs, 4);
  assert.equal(halfRow.fail_count, 2);
  assert.equal(halfRow.flaky_rate, 50, "2/4 -> 50.0");

  assert.equal(tqRow.total_runs, 4);
  assert.equal(tqRow.fail_count, 3);
  assert.equal(tqRow.flaky_rate, 75, "3/4 -> 75.0");
});

// ── suite filter ─────────────────────────────────────────────────────────

test("suite filter scopes results; omitting suite returns all suites", async () => {
  const token = await registerOrg("suitefilter");
  const stamp = Date.now();
  const suiteA = `filter-A-${stamp}`;
  const suiteB = `filter-B-${stamp}`;
  const testA = "A > flips";
  const testB = "B > flips";
  // One flaky test in each suite.
  await uploadRun(token, suiteA, [{ full_title: testA, title: "flips", status: "failed" }]);
  await uploadRun(token, suiteA, [{ full_title: testA, title: "flips", status: "passed" }]);
  await uploadRun(token, suiteB, [{ full_title: testB, title: "flips", status: "failed" }]);
  await uploadRun(token, suiteB, [{ full_title: testB, title: "flips", status: "passed" }]);

  // suite=A → only A's flaky test.
  const onlyA = await getFlaky(token, `?suite=${encodeURIComponent(suiteA)}`);
  assert.equal(onlyA.res.status, 200);
  assert.ok(onlyA.rows.some((r) => r.full_title === testA), "A's flaky test missing under suite=A");
  assert.ok(!onlyA.rows.some((r) => r.full_title === testB), "B leaked into suite=A filter");

  // No suite → both A and B (this org owns only these two suites).
  const all = await getFlaky(token, "");
  assert.equal(all.res.status, 200);
  assert.ok(all.rows.some((r) => r.full_title === testA), "A missing from unfiltered result");
  assert.ok(all.rows.some((r) => r.full_title === testB), "B missing from unfiltered result");
});

// ── run-window truncation header ─────────────────────────────────────────

test("run-window truncation: runs=1 over a 3-run org reports analyzed=1, window-truncated=true", async () => {
  const token = await registerOrg("window");
  const suite = `window-suite-${Date.now()}`;
  const t = "Win > flips";
  // Three runs: failed, passed, failed. With runs=1 the window only covers the
  // newest run, so the test won't even classify as flaky — but the header must
  // honestly report the truncated window (1 analyzed of 3 available).
  await uploadRun(token, suite, [{ full_title: t, title: "flips", status: "failed" }]);
  await uploadRun(token, suite, [{ full_title: t, title: "flips", status: "passed" }]);
  await uploadRun(token, suite, [{ full_title: t, title: "flips", status: "failed" }]);

  const { res } = await getFlaky(token, `?suite=${encodeURIComponent(suite)}&runs=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-flaky-runs-analyzed"), "1", "analyzed = min(runLimit, available)");
  assert.equal(res.headers.get("x-flaky-run-window-truncated"), "true", "3 available > 1 requested");

  // Sanity: a generous window over the same org reports the real count, no truncation.
  const wide = await getFlaky(token, `?suite=${encodeURIComponent(suite)}&runs=500`);
  assert.equal(wide.res.headers.get("x-flaky-runs-analyzed"), "3");
  assert.equal(wide.res.headers.get("x-flaky-run-window-truncated"), "false");
});

// ── result-limit truncation header ───────────────────────────────────────

test("result-limit truncation: more flaky tests than limit caps the body and sets the header", async () => {
  const token = await registerOrg("resultcap");
  const suite = `resultcap-suite-${Date.now()}`;
  // Three distinct flaky tests; ask for limit=2 so the body is capped at 2
  // and X-Flaky-Results-Truncated flips true (the route fetches limit+1 to
  // detect the overflow without a second COUNT).
  const titles = ["Cap > one", "Cap > two", "Cap > three"];
  await uploadRun(
    token,
    suite,
    titles.map((ft) => ({ full_title: ft, title: ft, status: "failed" as const }))
  );
  await uploadRun(
    token,
    suite,
    titles.map((ft) => ({ full_title: ft, title: ft, status: "passed" as const }))
  );

  const capped = await getFlaky(token, `?suite=${encodeURIComponent(suite)}&limit=2`);
  assert.equal(capped.res.status, 200);
  assert.equal(capped.rows.length, 2, "body capped to limit");
  assert.equal(capped.res.headers.get("x-flaky-results-truncated"), "true", "3 flaky > limit 2");

  // With a roomy limit the same org returns all 3 and the header is false.
  const full = await getFlaky(token, `?suite=${encodeURIComponent(suite)}&limit=50`);
  assert.equal(full.rows.length, 3, "all three flaky tests returned");
  assert.equal(full.res.headers.get("x-flaky-results-truncated"), "false");
});
