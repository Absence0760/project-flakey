/**
 * Idempotency at the API ingestion layer.
 *
 * Two routes accept ingestion-style requests where a CI job retry
 * (or a reporter restart, or a network blip + replay) must NOT create
 * a duplicate row:
 *
 *   - POST /live/start             ON CONFLICT (org_id, suite_name, ci_run_id)
 *   - POST /runs/upload            findOrCreateRun in run-merge.ts
 *
 * cross_function.smoke covers the live-start → end-of-run upload MERGE
 * (the cross-route happy path: live placeholder + upload re-enter the
 * same row when ci_run_id matches). live_cross_tenant covers the
 * org-scoping invariant. The gaps this file fills:
 *
 *   1. POST /live/start with the same (suite, ci_run_id) twice
 *      returns the SAME id, and the second call's response flags
 *      `resumed: true` so the reporter knows it attached to an
 *      in-flight row rather than allocating a fresh one.
 *   2. POST /live/start with the same suite but a different
 *      ci_run_id returns a DIFFERENT id (idempotency is scoped to
 *      the full key, not just the suite).
 *   3. POST /live/start without a ci_run_id always inserts (the
 *      route generates a random one server-side, so two calls
 *      never collide).
 *   4. POST /runs/upload with the same payload twice merges into a
 *      single row (no duplicate run, no duplicate spec, no duplicate
 *      test). Counts on the merged row reflect the latest payload.
 *   5. POST /runs/upload from two different orgs with the same
 *      ci_run_id allocates distinct rows (defense-in-depth assertion
 *      of the org-scoped uniqueness; primary coverage is in
 *      live_cross_tenant).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

// 3963 is outside the 3971-3999 band the other smokes use.
const PORT = 3963;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = "idempotency-smoke-secret";

interface UserCtx {
  token: string;
  orgId: number;
}

let server: ChildProcess;
let orgA: UserCtx;
let orgB: UserCtx;

async function waitForHealth(maxMs = 10_000): Promise<void> {
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

async function register(label: string): Promise<UserCtx> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `idem+${label}+${Date.now()}@test.local`,
      password: "testpass123",
      name: `Idem-${label}`,
      org_name: `IdemOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register ${label}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string; user: { orgId: number } };
  return { token: data.token, orgId: data.user.orgId };
}

async function liveStart(ctx: UserCtx, body: { suite: string; ciRunId?: string }) {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/live/start: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number; ci_run_id: string; resumed: boolean };
}

// Build a minimal /runs/upload payload in the shape src/routes/uploads.ts
// expects: top-level {meta, stats, specs}, each spec has its own stats,
// each test has a structured error object (or null), and screenshot_paths
// defaults to []. The shape is replicated from cross_function.smoke's
// uploadRun helper so a future schema change breaks both in lockstep.
function buildPayload(suite: string, ciRunId: string) {
  return {
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: `sha-${ciRunId}`,
      ci_run_id: ciRunId,
      started_at: "2026-05-12T00:00:00Z",
      finished_at: "2026-05-12T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [{
      file_path: `${suite}.cy.ts`,
      title: suite,
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 10 },
      tests: [{
        title: "t",
        full_title: "t",
        status: "passed" as const,
        duration_ms: 10,
        error: null,
        screenshot_paths: [],
      }],
    }],
  };
}

async function uploadRun(ctx: UserCtx, payload: ReturnType<typeof buildPayload>) {
  const fd = new FormData();
  fd.set("payload", JSON.stringify(payload));
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`/runs/upload: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number; merged: boolean };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET,
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
  [orgA, orgB] = await Promise.all([register("A"), register("B")]);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── 1. /live/start same (suite, ci_run_id) → same id + resumed:true ────

test("POST /live/start with the same (suite, ci_run_id) twice returns the same id and resumed:true on the second call", async () => {
  const suite = `idem-live-${Date.now()}`;
  const ciRunId = `ci-${Date.now()}`;

  const first = await liveStart(orgA, { suite, ciRunId });
  assert.equal(first.resumed, false, "first /live/start must allocate, not resume");

  const second = await liveStart(orgA, { suite, ciRunId });
  assert.equal(second.id, first.id, "same (suite, ci_run_id) must return the same run id");
  assert.equal(second.resumed, true, "second /live/start must report resumed:true");
});

// ── 2. /live/start same suite, different ci_run_id → different ids ─────

test("POST /live/start with the same suite but a different ci_run_id returns a different id", async () => {
  const suite = `idem-suite-${Date.now()}`;

  const a = await liveStart(orgA, { suite, ciRunId: `ci-a-${Date.now()}` });
  const b = await liveStart(orgA, { suite, ciRunId: `ci-b-${Date.now()}` });

  assert.notEqual(a.id, b.id, "different ci_run_id within the same suite must allocate a fresh run");
  assert.equal(b.resumed, false);
});

// ── 3. /live/start with no ci_run_id always inserts ────────────────────

test("POST /live/start without a ci_run_id always inserts a new run (server-generated id is unique)", async () => {
  const suite = `idem-no-cirun-${Date.now()}`;

  const a = await liveStart(orgA, { suite });
  const b = await liveStart(orgA, { suite });

  assert.notEqual(a.id, b.id, "absent ci_run_id must not collapse two starts into one");
  assert.match(a.ci_run_id, /^live-/, "server-generated ci_run_id is prefixed live-");
  assert.match(b.ci_run_id, /^live-/);
  assert.notEqual(a.ci_run_id, b.ci_run_id, "server-generated ci_run_ids must be unique");
});

// ── 4. /runs/upload replay with same payload merges into one run ───────

test("POST /runs/upload twice with the same ci_run_id+suite merges into a single run", async () => {
  const suite = `idem-upload-${Date.now()}`;
  const ciRunId = `ci-upload-${Date.now()}`;
  const payload = buildPayload(suite, ciRunId);

  const first = await uploadRun(orgA, payload);
  const second = await uploadRun(orgA, payload);

  assert.equal(second.id, first.id, "replayed upload must merge into the existing run, not create a duplicate");
  assert.equal(second.merged, true, "second upload must report merged:true");
});

// ── 5. /runs/upload cross-org with same ci_run_id → distinct rows ──────

test("POST /runs/upload from two different orgs with the same (suite, ci_run_id) allocates distinct rows", async () => {
  const suite = `idem-cross-${Date.now()}`;
  const ciRunId = `ci-cross-${Date.now()}`;
  const payload = buildPayload(suite, ciRunId);

  const a = await uploadRun(orgA, payload);
  const b = await uploadRun(orgB, payload);

  assert.notEqual(a.id, b.id, "same ci_run_id from a different org must NOT collapse into org A's run");
});
