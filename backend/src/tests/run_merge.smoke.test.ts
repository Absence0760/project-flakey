// Run-merge smoke — exercises src/run-merge.ts end-to-end through
// POST /runs/upload and GET /runs/:id. This hot-path module (the ci_run_id
// merge of concurrent shards onto one run, plus the post-merge stat recompute)
// had zero direct coverage despite being the source of recent live-flow bugs.
//
// Invariants pinned here:
//   - same ci_run_id + suite_name merges into ONE run; stats are recomputed as
//     the SUM across all merged shards (recalculateRunStats)
//   - total == passed + failed + skipped + pending always holds after a merge,
//     and skipped/pending stay disjoint (regression for migration 048)
//   - finished_at advances to the latest reporter clock (GREATEST), never
//     regresses to an earlier shard's value
//   - environment is backfilled when the run had none, but an existing
//     non-empty environment is never overwritten
//   - an empty ci_run_id never merges; a different suite_name never merges
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3974;
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

type TestStatus = "passed" | "failed" | "skipped" | "pending";
interface SpecInput {
  file_path: string;
  tests: TestStatus[];
}
interface UploadInput {
  suite: string;
  ciRunId?: string;
  environment?: string;
  finishedAt?: string;
  startedAt?: string;
  specs: SpecInput[];
}

interface Counts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
}

function countOf(statuses: TestStatus[]): Counts {
  return {
    total: statuses.length,
    passed: statuses.filter((s) => s === "passed").length,
    failed: statuses.filter((s) => s === "failed").length,
    skipped: statuses.filter((s) => s === "skipped").length,
    pending: statuses.filter((s) => s === "pending").length,
  };
}

// Build a well-formed {meta, stats, specs} payload from a list of test
// statuses per spec. spec.stats and the run-level stats are derived from the
// same statuses as the test rows, so the upload is internally consistent —
// exactly what a real normalizer emits.
function buildPayload(input: UploadInput): string {
  const specs = input.specs.map((sp, i) => {
    const c = countOf(sp.tests);
    return {
      file_path: sp.file_path,
      title: sp.file_path,
      stats: { total: c.total, passed: c.passed, failed: c.failed, skipped: c.skipped, pending: c.pending, duration_ms: c.total * 10 },
      tests: sp.tests.map((status, t) => ({
        title: `${sp.file_path} test ${t}`,
        full_title: `${sp.file_path} test ${t}`,
        status,
        duration_ms: 10,
        screenshot_paths: [],
      })),
      _i: i,
    };
  });
  const agg = input.specs.flatMap((sp) => sp.tests);
  const c = countOf(agg);
  return JSON.stringify({
    meta: {
      suite_name: input.suite,
      branch: "main",
      commit_sha: `sha-${input.suite}`,
      ci_run_id: input.ciRunId ?? "",
      reporter: "mochawesome",
      environment: input.environment,
      started_at: input.startedAt ?? "2026-05-10T00:00:00Z",
      finished_at: input.finishedAt ?? "2026-05-10T00:00:10Z",
    },
    stats: { total: c.total, passed: c.passed, failed: c.failed, skipped: c.skipped, pending: c.pending, duration_ms: c.total * 10 },
    specs: specs.map(({ _i, ...rest }) => rest),
  });
}

interface UploadResult { id: number; merged: boolean; status: number; }
async function upload(input: UploadInput): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("payload", buildPayload(input));
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: number; merged: boolean };
  return { ...body, status: res.status };
}

interface RunRow {
  id: number;
  total: number; passed: number; failed: number; skipped: number; pending: number;
  duration_ms: number;
  finished_at: string;
  environment: string;
  ci_run_id: string;
  specs: Array<{ id: number; file_path: string }>;
}
async function getRun(id: number): Promise<RunRow> {
  const res = await fetch(`${BASE}/runs/${id}`, { headers: auth() });
  if (!res.ok) throw new Error(`GET /runs/${id} failed: ${res.status}`);
  return (await res.json()) as RunRow;
}

function assertInvariant(run: RunRow): void {
  assert.equal(
    run.total,
    run.passed + run.failed + run.skipped + run.pending,
    `run ${run.id}: total must equal passed+failed+skipped+pending`,
  );
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "run-merge-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
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
      email: `run-merge+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Run Merge",
      org_name: `RunMergeOrg-${Date.now()}`,
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

// A fresh ci_run_id per test keeps cases independent of each other and of any
// seed data, while still exercising the real partial-unique-index merge.
function ciRunId(label: string): string {
  return `ci-${label}-${Date.now()}-${Math.round(performance.now())}`;
}

// ── Merge: two shards onto one run ──────────────────────────────────────

test("two shards with the same ci_run_id + suite merge into one run and the second reports merged=true", async () => {
  const suite = `merge-basic-${Date.now()}`;
  const ci = ciRunId("basic");

  const a = await upload({ suite, ciRunId: ci, specs: [{ file_path: "a.spec.ts", tests: ["passed", "passed"] }] });
  assert.equal(a.status, 201, "first upload creates a new run (201)");
  assert.equal(a.merged, false, "first upload is not a merge");

  const b = await upload({ suite, ciRunId: ci, specs: [{ file_path: "b.spec.ts", tests: ["failed", "passed"] }] });
  assert.equal(b.status, 200, "second upload merges (200)");
  assert.equal(b.merged, true, "second upload is a merge");
  assert.equal(b.id, a.id, "both shards land on the same run id");

  const run = await getRun(a.id);
  // Stats are the SUM across both shards, recomputed from specs.
  assert.equal(run.total, 4, "total = 2 + 2 across shards");
  assert.equal(run.passed, 3, "passed = 2 + 1");
  assert.equal(run.failed, 1, "failed = 0 + 1");
  assert.equal(run.specs.length, 2, "both shards' specs are present on the run");
  assertInvariant(run);
});

// ── recalc keeps skipped + pending disjoint (migration 048 regression) ──

test("merge recomputes skipped and pending as disjoint sums (no double-count)", async () => {
  const suite = `merge-disjoint-${Date.now()}`;
  const ci = ciRunId("disjoint");

  // Shard 1: 1 passed, 1 skipped, 1 pending.
  await upload({ suite, ciRunId: ci, specs: [{ file_path: "s1.spec.ts", tests: ["passed", "skipped", "pending"] }] });
  // Shard 2: 2 pending, 1 skipped.
  const b = await upload({ suite, ciRunId: ci, specs: [{ file_path: "s2.spec.ts", tests: ["pending", "pending", "skipped"] }] });

  const run = await getRun(b.id);
  assert.equal(run.passed, 1, "passed = 1");
  assert.equal(run.skipped, 2, "skipped = 1 + 1 (skipped only, NOT including pending)");
  assert.equal(run.pending, 3, "pending = 1 + 2 (pending only, NOT folded into skipped)");
  assert.equal(run.total, 6, "total = 6");
  // The whole point of migration 048: skipped and pending are separate
  // counters, so they sum independently and the invariant still holds.
  assertInvariant(run);
});

// ── finished_at advances to the latest reporter clock (GREATEST) ────────

test("finished_at advances to the latest shard's reporter clock and never regresses", async () => {
  const suite = `merge-finished-${Date.now()}`;
  const ci = ciRunId("finished");

  await upload({ suite, ciRunId: ci, finishedAt: "2026-05-10T00:00:10Z", specs: [{ file_path: "f1.spec.ts", tests: ["passed"] }] });

  // Later shard → finished_at moves forward.
  const b = await upload({ suite, ciRunId: ci, finishedAt: "2026-05-10T00:05:00Z", specs: [{ file_path: "f2.spec.ts", tests: ["passed"] }] });
  let run = await getRun(b.id);
  assert.equal(new Date(run.finished_at).toISOString(), "2026-05-10T00:05:00.000Z", "finished_at advances to the later shard");

  // Earlier shard → finished_at must NOT regress.
  await upload({ suite, ciRunId: ci, finishedAt: "2026-05-10T00:01:00Z", specs: [{ file_path: "f3.spec.ts", tests: ["passed"] }] });
  run = await getRun(b.id);
  assert.equal(new Date(run.finished_at).toISOString(), "2026-05-10T00:05:00.000Z", "an earlier shard does not pull finished_at back");
});

// ── environment backfill ────────────────────────────────────────────────

test("environment is backfilled from a later shard when the run started without one", async () => {
  const suite = `merge-env-backfill-${Date.now()}`;
  const ci = ciRunId("envbf");

  await upload({ suite, ciRunId: ci, specs: [{ file_path: "e1.spec.ts", tests: ["passed"] }] }); // no environment
  const b = await upload({ suite, ciRunId: ci, environment: "staging", specs: [{ file_path: "e2.spec.ts", tests: ["passed"] }] });

  const run = await getRun(b.id);
  assert.equal(run.environment, "staging", "empty environment is backfilled by a shard that carries one");
});

test("an existing non-empty environment is never overwritten by a later shard", async () => {
  const suite = `merge-env-keep-${Date.now()}`;
  const ci = ciRunId("envkeep");

  await upload({ suite, ciRunId: ci, environment: "production", specs: [{ file_path: "e1.spec.ts", tests: ["passed"] }] });
  const b = await upload({ suite, ciRunId: ci, environment: "staging", specs: [{ file_path: "e2.spec.ts", tests: ["passed"] }] });

  const run = await getRun(b.id);
  assert.equal(run.environment, "production", "the first shard's environment wins; a later shard does not clobber it");
});

// ── no-merge cases ──────────────────────────────────────────────────────

test("uploads with an empty ci_run_id never merge — each creates a distinct run", async () => {
  const suite = `merge-nocirun-${Date.now()}`;

  const a = await upload({ suite, ciRunId: "", specs: [{ file_path: "n1.spec.ts", tests: ["passed"] }] });
  const b = await upload({ suite, ciRunId: "", specs: [{ file_path: "n2.spec.ts", tests: ["passed"] }] });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.merged, false, "no ci_run_id means no merge");
  assert.notEqual(a.id, b.id, "two ci_run_id-less uploads are two separate runs");
});

test("the same ci_run_id under a different suite does NOT merge (suite_name is part of the conflict key)", async () => {
  const ci = ciRunId("crosssuite");
  const suiteA = `merge-suiteA-${Date.now()}`;
  const suiteB = `merge-suiteB-${Date.now()}`;

  const a = await upload({ suite: suiteA, ciRunId: ci, specs: [{ file_path: "x.spec.ts", tests: ["passed"] }] });
  const b = await upload({ suite: suiteB, ciRunId: ci, specs: [{ file_path: "x.spec.ts", tests: ["passed"] }] });

  assert.equal(b.merged, false, "same ci_run_id but different suite is a different run");
  assert.notEqual(a.id, b.id, "the merge key is (org, suite_name, ci_run_id) — suite differs, so no merge");
});
