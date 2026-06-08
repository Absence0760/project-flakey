/**
 * Regression: test-row ids must survive the live→final merge.
 *
 * While a run streams live (POST /live/:id/events), the backend creates real
 * `tests` rows so the run-detail page can render scenarios in real time. The
 * end-of-run batch upload (POST /runs/upload) used to DELETE every test row for
 * the spec and re-INSERT the authoritative list — reassigning every tests.id.
 *
 * That reassignment 404'd the run-detail test modal: a user who clicked a
 * passed/failed scenario in the window before their next poll/refetch hit
 * GET /tests/<old-id> → "Test not found". It also nulled visual_diffs.test_id
 * (ON DELETE SET NULL) on every merge.
 *
 * The merge now reconciles rows in place, matching by full_title. This asserts
 * the live ids are preserved across the merge and that fetching a test by its
 * pre-merge id still resolves.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

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

interface RunDetail {
  specs: Array<{ file_path: string; tests: Array<{ id: number; full_title: string; status: string }> }>;
}

async function fetchRun(runId: number): Promise<RunDetail> {
  const res = await fetch(`${BASE}/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`fetchRun ${runId} failed: ${res.status}`);
  return res.json() as Promise<RunDetail>;
}

/** Poll the run until its tests reach the expected terminal state (live events
 *  process asynchronously after POST /events returns). */
async function waitForTests(runId: number, predicate: (d: RunDetail) => boolean, maxMs = 8000): Promise<RunDetail> {
  const start = Date.now();
  let last: RunDetail | null = null;
  while (Date.now() - start < maxMs) {
    last = await fetchRun(runId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`run ${runId} never reached expected state; last: ${JSON.stringify(last)}`);
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "idstability-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
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
      email: `idstability+${Date.now()}@test.local`,
      password: "testpass123",
      name: "IdStability",
      org_name: `IdStabilityOrg-${Date.now()}`,
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

test("live test ids survive the end-of-run batch merge", async () => {
  const suite = `idstability-${Date.now()}`;
  const ciRunId = `ci-idstability-${Date.now()}`;
  const SPEC = "checkout.cy.ts";
  const PASS_TITLE = "checkout > completes the order";
  const FAIL_TITLE = "checkout > rejects an expired card";

  // 1) Start a live run and stream two test results into it.
  const startRes = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ suite, ciRunId }),
  });
  if (!startRes.ok) throw new Error(`live/start failed: ${startRes.status}`);
  const runId = ((await startRes.json()) as { id: number }).id;

  const evRes = await fetch(`${BASE}/live/${runId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify([
      { type: "test.started", spec: SPEC, test: PASS_TITLE },
      { type: "test.passed", spec: SPEC, test: PASS_TITLE, duration_ms: 120 },
      { type: "test.started", spec: SPEC, test: FAIL_TITLE },
      { type: "test.failed", spec: SPEC, test: FAIL_TITLE, duration_ms: 90, error: "card expired" },
    ]),
  });
  if (!evRes.ok) throw new Error(`live/events failed: ${evRes.status}`);

  // 2) Capture the live-path ids once both rows reach a terminal state.
  const live = await waitForTests(
    runId,
    (d) => {
      const tests = d.specs.flatMap((s) => s.tests);
      return tests.length === 2 && tests.every((t) => t.status === "passed" || t.status === "failed");
    },
  );
  const liveIdByTitle = new Map(live.specs.flatMap((s) => s.tests).map((t) => [t.full_title, t.id]));
  assert.ok(liveIdByTitle.has(PASS_TITLE) && liveIdByTitle.has(FAIL_TITLE), "both live rows present");

  // 3) Upload the authoritative batch into the SAME run (same suite + ci_run_id → merge).
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id: ciRunId,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [
      {
        file_path: SPEC,
        title: "checkout",
        stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 30000 },
        tests: [
          { title: "completes the order", full_title: PASS_TITLE, status: "passed", duration_ms: 120, screenshot_paths: [] },
          { title: "rejects an expired card", full_title: FAIL_TITLE, status: "failed", duration_ms: 90, error: { message: "card expired" }, screenshot_paths: [] },
        ],
      },
    ],
  }));

  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
  const upBody = (await up.json()) as { id: number; merged: boolean };
  assert.equal(upBody.id, runId, "upload should merge into the live run, not create a new one");
  assert.equal(upBody.merged, true, "upload should be a merge");

  // 4) The ids must be unchanged across the merge.
  const after = await fetchRun(runId);
  const afterIdByTitle = new Map(after.specs.flatMap((s) => s.tests).map((t) => [t.full_title, t.id]));
  assert.equal(afterIdByTitle.get(PASS_TITLE), liveIdByTitle.get(PASS_TITLE), "passed test id preserved across merge");
  assert.equal(afterIdByTitle.get(FAIL_TITLE), liveIdByTitle.get(FAIL_TITLE), "failed test id preserved across merge");

  // 5) And the pre-merge id still resolves via GET /tests/:id (the modal's call).
  for (const title of [PASS_TITLE, FAIL_TITLE]) {
    const id = liveIdByTitle.get(title)!;
    const res = await fetch(`${BASE}/tests/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `GET /tests/${id} (${title}) should resolve after merge, not 404`);
  }
});
