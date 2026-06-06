/**
 * Predict-route smoke tests — the CI test-selection + spec-splitting workflow.
 *
 * Protects the real client workflow:
 *   - CI POSTs changed files to /predict/tests and gets a ranked re-run list
 *     (heuristic scoring on historical failures + path matches, no AI).
 *   - CI calls GET /predict/split?suite=&workers=N to balance specs across
 *     N workers via greedy bin-packing on historical per-spec duration.
 *
 * Score formula (verified in src/routes/predict.ts):
 *   - historical_failures > 0 → min(1, 0.5 + failures/total * 0.5)
 *   - else (path-only match)  → 0.3 constant
 * Results sort by score desc and cap at 50.
 *
 * Split: greedy assign heaviest spec to lightest worker; round-robin fallback
 * when no duration history; worker count clamped to [1, 50].
 *
 * Each test owns its own org + uploads, so assertions don't depend on seed
 * data or other agents sharing the DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3951;
const BASE = `http://localhost:${PORT}`;

// Unique-per-run token so our path segments only match data we created.
const TAG = `predzz${Date.now()}`;

let server: ChildProcess;
let token: string;

// Spec file paths (segment = filename without extension, lowercased, len>=3).
const CART_SPEC = `cart${TAG}.cy.ts`; // historical_failures=1, total=2 -> 0.75
const LOGIN_SPEC = `login${TAG}.cy.ts`; // historical_failures=1, total=4 -> 0.625
const SEARCH_SPEC = `search${TAG}.cy.ts`; // never failed -> path_match 0.3

const CART_TEST = `Cart ${TAG} > should checkout`;
const LOGIN_TEST = `Login ${TAG} > should authenticate`;
const SEARCH_TEST = `Search ${TAG} > should always pass`;

const SUITE = `predict-suite-${TAG}`;
const OTHER_SUITE = `predict-other-suite-${TAG}`;

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

function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function get(path: string) {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

type SpecInput = {
  file_path: string;
  tests: Array<{ full_title: string; status: "passed" | "failed"; duration_ms: number }>;
};

// Upload one run via the direct {meta,stats,specs} path. A unique ci_run_id
// per call creates a distinct run row (merge key is org+suite+ci_run_id), so
// each call counts as a separate historical appearance.
async function uploadRun(suite: string, specs: SpecInput[]): Promise<number> {
  let total = 0, passed = 0, failed = 0, duration = 0;
  const normalizedSpecs = specs.map((spec) => {
    let sTotal = 0, sPassed = 0, sFailed = 0, sDuration = 0;
    const tests = spec.tests.map((t) => {
      sTotal++;
      if (t.status === "passed") sPassed++;
      else sFailed++;
      sDuration += t.duration_ms;
      return {
        title: t.full_title.split(" > ").slice(-1)[0],
        full_title: t.full_title,
        status: t.status,
        duration_ms: t.duration_ms,
        screenshot_paths: [],
        ...(t.status === "failed"
          ? { error: { message: "AssertionError: boom", stack: "at line 1" } }
          : {}),
      };
    });
    total += sTotal; passed += sPassed; failed += sFailed; duration += sDuration;
    return {
      file_path: spec.file_path,
      title: spec.file_path,
      stats: { total: sTotal, passed: sPassed, failed: sFailed, skipped: 0, pending: 0, duration_ms: sDuration },
      tests,
    };
  });

  const ciRunId = `ci-${TAG}-${Math.random().toString(36).slice(2)}`;
  const res = await post("/runs", {
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: ciRunId,
      ci_run_id: ciRunId,
      started_at: "2026-05-01T00:00:00Z",
      finished_at: "2026-05-01T00:01:00Z",
      reporter: "mochawesome",
    },
    stats: { total, passed, failed, skipped: 0, pending: 0, duration_ms: duration },
    specs: normalizedSpecs,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => "")}`);
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
      JWT_SECRET: "predict-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const email = `predict+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "Predict",
      org_name: `PredictOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  token = ((await reg.json()) as { token: string }).token;

  // CART_TEST: fails 1 of 2 runs -> failures=1, total=2 -> score 0.75.
  await uploadRun(SUITE, [{ file_path: CART_SPEC, tests: [{ full_title: CART_TEST, status: "failed", duration_ms: 100 }] }]);
  await uploadRun(SUITE, [{ file_path: CART_SPEC, tests: [{ full_title: CART_TEST, status: "passed", duration_ms: 100 }] }]);

  // LOGIN_TEST: fails 1 of 4 runs -> failures=1, total=4 -> score 0.625.
  await uploadRun(SUITE, [{ file_path: LOGIN_SPEC, tests: [{ full_title: LOGIN_TEST, status: "failed", duration_ms: 100 }] }]);
  await uploadRun(SUITE, [{ file_path: LOGIN_SPEC, tests: [{ full_title: LOGIN_TEST, status: "passed", duration_ms: 100 }] }]);
  await uploadRun(SUITE, [{ file_path: LOGIN_SPEC, tests: [{ full_title: LOGIN_TEST, status: "passed", duration_ms: 100 }] }]);
  await uploadRun(SUITE, [{ file_path: LOGIN_SPEC, tests: [{ full_title: LOGIN_TEST, status: "passed", duration_ms: 100 }] }]);

  // SEARCH_TEST: always passes -> never failed -> path_match constant 0.3.
  await uploadRun(SUITE, [{ file_path: SEARCH_SPEC, tests: [{ full_title: SEARCH_TEST, status: "passed", duration_ms: 100 }] }]);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── POST /predict/tests ──────────────────────────────────────────────────

test("POST /predict/tests requires a non-empty changedFiles array", async () => {
  const res = await post("/predict/tests", {});
  assert.equal(res.status, 400);
  const empty = await post("/predict/tests", { changedFiles: [] });
  assert.equal(empty.status, 400);
});

test("POST /predict/tests scores by failure ratio and sorts highest first", async () => {
  // Changed files reference all three spec segments. Stoplisted dir segments
  // ('src') must be ignored — only the filename segments should match.
  const res = await post("/predict/tests", {
    changedFiles: [
      `src/${CART_SPEC}`,
      `src/${LOGIN_SPEC}`,
      `src/${SEARCH_SPEC}`,
    ],
  });
  assert.equal(res.status, 200);
  const { tests } = (await res.json()) as {
    tests: Array<{ full_title: string; file_path: string; score: number; reason: string }>;
  };

  const cart = tests.find((t) => t.full_title === CART_TEST);
  const login = tests.find((t) => t.full_title === LOGIN_TEST);
  const search = tests.find((t) => t.full_title === SEARCH_TEST);

  assert.ok(cart, "cart test missing from prediction");
  assert.ok(login, "login test missing from prediction");
  assert.ok(search, "search test missing from prediction");

  // Exact documented scores: 0.5 + failures/total * 0.5.
  assert.equal(cart!.score, 0.75); // 0.5 + 1/2 * 0.5
  assert.equal(login!.score, 0.625); // 0.5 + 1/4 * 0.5
  assert.equal(search!.score, 0.3); // path-only match constant

  // Reasons reflect the failure history.
  assert.equal(cart!.reason, "previously_failed");
  assert.equal(login!.reason, "previously_failed");
  assert.equal(search!.reason, "path_match");

  // Higher-ratio failure sorts above lower-ratio, which sorts above path-only.
  const cartIdx = tests.findIndex((t) => t.full_title === CART_TEST);
  const loginIdx = tests.findIndex((t) => t.full_title === LOGIN_TEST);
  const searchIdx = tests.findIndex((t) => t.full_title === SEARCH_TEST);
  assert.ok(cartIdx < loginIdx, "0.75-score test must sort above 0.625-score test");
  assert.ok(loginIdx < searchIdx, "0.625-score test must sort above 0.3 path-match");

  // Whole list is sorted by score descending.
  for (let i = 1; i < tests.length; i++) {
    assert.ok(tests[i - 1].score >= tests[i].score, "results not sorted by score desc");
  }
});

test("POST /predict/tests ignores stoplisted segments (no match -> empty)", async () => {
  // Only stoplisted/short segments -> no usable segments -> empty result.
  const res = await post("/predict/tests", { changedFiles: ["src/index.ts", "lib/app.js"] });
  assert.equal(res.status, 200);
  const { tests } = (await res.json()) as { tests: unknown[] };
  assert.deepEqual(tests, [], "stoplisted-only changed files should yield no predictions");
});

test("POST /predict/tests suite filter narrows to the named suite", async () => {
  // Upload the same-named CART test into a different suite under a path whose
  // segment ('checkout') does not collide with the SUITE specs. Then filter by
  // OTHER_SUITE and assert only that suite's row comes back.
  const otherTest = `Checkout ${TAG} > should pay`;
  await uploadRun(OTHER_SUITE, [
    { file_path: `checkout${TAG}.cy.ts`, tests: [{ full_title: otherTest, status: "failed", duration_ms: 100 }] },
  ]);

  const filtered = await post("/predict/tests", {
    changedFiles: [`checkout${TAG}.cy.ts`, CART_SPEC],
    suite: OTHER_SUITE,
  });
  assert.equal(filtered.status, 200);
  const { tests } = (await filtered.json()) as {
    tests: Array<{ full_title: string; suite_name: string }>;
  };
  assert.ok(tests.length >= 1, "expected the other-suite match");
  assert.ok(tests.every((t) => t.suite_name === OTHER_SUITE),
    "suite filter leaked rows from another suite");
  assert.ok(tests.some((t) => t.full_title === otherTest), "other-suite test missing");
  // The SUITE cart test must NOT appear under the OTHER_SUITE filter.
  assert.ok(!tests.some((t) => t.full_title === CART_TEST), "suite filter did not exclude SUITE rows");
});

// ── GET /predict/split ─────────────────────────────────────────────────────

test("GET /predict/split requires a suite query param", async () => {
  const res = await get("/predict/split?workers=3");
  assert.equal(res.status, 400);
});

test("GET /predict/split greedy-balances specs by avg duration", async () => {
  // Fresh suite with three specs of known, distinct durations so bin-packing
  // is deterministic: 300 / 200 / 100 ms across two workers.
  // Greedy (heaviest-first to lightest worker):
  //   w0 <- 300; w1 <- 200; then 100 -> lightest is w1 (200) => w1=300.
  // Result: w0={A:300}, w1={B,C:300}. Both estimated_ms = 300.
  const splitSuite = `split-balanced-${TAG}`;
  const A = `alpha${TAG}.cy.ts`;
  const B = `bravo${TAG}.cy.ts`;
  const C = `charlie${TAG}.cy.ts`;
  await uploadRun(splitSuite, [
    { file_path: A, tests: [{ full_title: `A ${TAG} > t`, status: "passed", duration_ms: 300 }] },
    { file_path: B, tests: [{ full_title: `B ${TAG} > t`, status: "passed", duration_ms: 200 }] },
    { file_path: C, tests: [{ full_title: `C ${TAG} > t`, status: "passed", duration_ms: 100 }] },
  ]);

  const res = await get(`/predict/split?suite=${encodeURIComponent(splitSuite)}&workers=2`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    strategy: string;
    workers: Array<{ index: number; specs: string[]; estimated_ms: number }>;
  };
  assert.equal(data.strategy, "balanced");
  assert.equal(data.workers.length, 2);

  // Every spec assigned exactly once.
  const assigned = data.workers.flatMap((w) => w.specs).sort();
  assert.deepEqual(assigned, [A, B, C].sort());

  // estimated_ms reflects the real per-worker sum of avg durations.
  for (const w of data.workers) {
    const sum = w.specs.reduce((acc, f) => acc + ({ [A]: 300, [B]: 200, [C]: 100 }[f] ?? 0), 0);
    assert.equal(w.estimated_ms, sum, `worker ${w.index} estimated_ms mismatch`);
  }

  // Heaviest spec is alone on its worker; the other two share the second.
  const heavyWorker = data.workers.find((w) => w.specs.includes(A))!;
  const otherWorker = data.workers.find((w) => !w.specs.includes(A))!;
  assert.deepEqual(heavyWorker.specs, [A]);
  assert.deepEqual(otherWorker.specs.sort(), [B, C].sort());
  // Greedy bin-packing balanced both workers to 300ms total.
  assert.equal(heavyWorker.estimated_ms, 300);
  assert.equal(otherWorker.estimated_ms, 300);
});

test("GET /predict/split falls back to round-robin with no duration history", async () => {
  // Specs uploaded with duration_ms = 0 each. The balanced query keys off
  // AVG(duration_ms); with all-zero durations the rows still exist, so the
  // route stays 'balanced' but distributes round-robin-like by zero weight.
  // To exercise the documented round_robin fallback we need ZERO matched
  // rows from the 30-day window — which can't happen for freshly uploaded
  // runs. Instead assert the documented contract for a suite that simply has
  // no specs at all: an empty, well-formed worker layout.
  const emptySuite = `split-empty-${TAG}`;
  const res = await get(`/predict/split?suite=${encodeURIComponent(emptySuite)}&workers=3`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    strategy: string;
    workers: Array<{ index: number; specs: string[]; estimated_ms: number }>;
  };
  // No matching rows -> documented round_robin fallback branch.
  assert.equal(data.strategy, "round_robin");
  assert.equal(data.workers.length, 3);
  assert.ok(data.workers.every((w) => w.specs.length === 0 && w.estimated_ms === 0));
  assert.deepEqual(data.workers.map((w) => w.index), [0, 1, 2]);
});

test("GET /predict/split clamps worker count to [1, 50]", async () => {
  // Math.max(1, Math.min(Number(workers) || 2, 50)).
  // A negative count clamps up to the floor of 1.
  const lo = await get(`/predict/split?suite=${encodeURIComponent(SUITE)}&workers=-5`);
  assert.equal(lo.status, 200);
  const loData = (await lo.json()) as { workers: unknown[] };
  assert.equal(loData.workers.length, 1, "negative workers should clamp to floor 1");

  // An over-large count clamps down to the ceiling of 50.
  const hi = await get(`/predict/split?suite=${encodeURIComponent(SUITE)}&workers=999`);
  assert.equal(hi.status, 200);
  const hiData = (await hi.json()) as { workers: unknown[] };
  assert.equal(hiData.workers.length, 50, "workers=999 should clamp to 50");

  // Missing / unparseable / zero falls through to the default of 2 (|| 2).
  const def = await get(`/predict/split?suite=${encodeURIComponent(SUITE)}`);
  assert.equal(def.status, 200);
  const defData = (await def.json()) as { workers: unknown[] };
  assert.equal(defData.workers.length, 2, "missing workers should default to 2");
});
