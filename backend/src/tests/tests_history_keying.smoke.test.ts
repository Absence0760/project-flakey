/**
 * Regression: GET /tests/:id/history must key on full_title, not the leaf
 * title.
 *
 * Two tests can share a leaf title ("should work") while living under
 * different describe() blocks of the same spec file — distinct full_titles.
 * Keying history on the leaf title alone collapses them into one bogus
 * timeline that mixes both tests' pass/fail rows. The flaky route already
 * keys on full_title; this endpoint must match.
 *
 * Setup: one spec file with two same-leaf tests (one always-passed, one
 * always-failed), uploaded across two runs. History for the passing test
 * must return only its own 2 rows (all "passed") — not all 4.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3994;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

const FILE = "shared-leaf.cy.ts";
const PASS_FULL = "Suite A > should work";
const FAIL_FULL = "Suite B > should work";

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

function uploadRun(seq: number) {
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: "history-keying",
      branch: "main",
      commit_sha: `sha${seq}`,
      ci_run_id: `ci-histkey-${Date.now()}-${seq}`,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [{
      file_path: FILE,
      title: "shared-leaf",
      stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 30000 },
      tests: [
        // Same leaf title "should work", different full_title.
        { title: "should work", full_title: PASS_FULL, status: "passed", duration_ms: 100, screenshot_paths: [] },
        { title: "should work", full_title: FAIL_FULL, status: "failed", duration_ms: 50, screenshot_paths: [],
          error: { message: "AssertionError", stack: "at line 5" } },
      ],
    }],
  }));
  return fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "histkey-test-secret",
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
      email: `histkey+${Date.now()}@test.local`,
      password: "testpass123",
      name: "HistKey",
      org_name: `HistKeyOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;

  for (const seq of [1, 2]) {
    const up = await uploadRun(seq);
    if (!up.ok) throw new Error(`upload ${seq} failed: ${up.status} ${await up.text().catch(() => "")}`);
  }
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("history is scoped to full_title, not the shared leaf title", async () => {
  // Find the passing test's id from the latest run detail.
  const runs = await (await fetch(`${BASE}/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { runs: Array<{ id: number }> };
  const latest = runs.runs[0].id;
  const detail = await (await fetch(`${BASE}/runs/${latest}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { specs: Array<{ tests: Array<{ id: number; full_title: string }> }> };
  const passTest = detail.specs.flatMap((s) => s.tests).find((t) => t.full_title === PASS_FULL);
  assert.ok(passTest, "passing test not found in run detail");

  const res = await fetch(`${BASE}/tests/${passTest.id}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json() as {
    full_title: string;
    history: Array<{ status: string }>;
  };

  assert.equal(data.full_title, PASS_FULL, "response should echo full_title");
  // Two runs, each with exactly one "Suite A > should work" — never the 4
  // rows the leaf-title bug would have merged in.
  assert.equal(data.history.length, 2, `expected 2 history rows, got ${data.history.length}`);
  assert.ok(
    data.history.every((h) => h.status === "passed"),
    "history must contain only the passing test's rows, not the same-leaf failing test",
  );
});
