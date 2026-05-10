// Basic-functionality smoke for the /runs query surface — pagination,
// distinct environments, and the CI auto-cancellation predicate. Each
// of these is wired up to a UI affordance (the runs-list "Load more"
// button, the env filter dropdown, the CI workflow's `should_cancel`
// gate) but none had explicit coverage before.
//
//   1. GET /runs?limit=N&offset=M returns a contiguous slice with
//      summary.total reflecting the org-wide count. Pages don't
//      overlap; hasMore tracks correctly.
//
//   2. GET /runs/environments returns the distinct non-empty
//      environment values for the caller's org — what powers the
//      dashboard's environment filter dropdown.
//
//   3. GET /runs/check?ci_run_id=...&threshold=N returns
//      should_cancel=true when the latest run's failed count
//      crosses the threshold, and false otherwise. The CI
//      auto-cancellation workflow calls this on each shard before
//      executing — a regression here means failing builds can't
//      short-circuit themselves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3977;
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

type UploadOpts = {
  suite: string;
  ciRunId: string;
  environment?: string;
  failed?: number;
  passed?: number;
};

async function uploadRun(opts: UploadOpts): Promise<number> {
  const passed = opts.passed ?? 1;
  const failed = opts.failed ?? 0;
  const total = passed + failed;
  const tests = [
    ...Array.from({ length: passed }, (_, i) => ({
      title: `pass-${i}`, full_title: `pass-${i}`, status: "passed",
      duration_ms: 10, screenshot_paths: [],
    })),
    ...Array.from({ length: failed }, (_, i) => ({
      title: `fail-${i}`, full_title: `fail-${i}`, status: "failed",
      duration_ms: 10, error: { message: "boom" }, screenshot_paths: [],
    })),
  ];

  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: opts.suite,
        branch: "main",
        commit_sha: `sha-${opts.ciRunId}`,
        ci_run_id: opts.ciRunId,
        started_at: "2026-05-10T00:00:00Z",
        finished_at: "2026-05-10T00:00:10Z",
        reporter: "mochawesome",
        environment: opts.environment ?? "",
      },
      stats: { total, passed, failed, skipped: 0, pending: 0, duration_ms: 10000 },
      specs: [
        {
          file_path: `${opts.suite}.cy.ts`,
          title: opts.suite,
          stats: { total, passed, failed, skipped: 0, duration_ms: 10000 },
          tests,
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
      JWT_SECRET: "runs-query-test-secret",
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
      email: `runs-query+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Runs Query",
      org_name: `RunsQueryOrg-${Date.now()}`,
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

// ── 1. Pagination ───────────────────────────────────────────────────

test("GET /runs?limit=N&offset=M returns a contiguous slice, summary.total reflects the org-wide count", async () => {
  // Upload three runs in a fresh org so we can predict the
  // pagination boundaries exactly.
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await uploadRun({
      suite: "pagination",
      ciRunId: `pag-${Date.now()}-${i}`,
      passed: 1,
    }));
  }

  // Page 1: limit 2, offset 0.
  const page1 = await fetch(`${BASE}/runs?limit=2&offset=0`, { headers: auth() });
  assert.equal(page1.status, 200);
  const body1 = (await page1.json()) as {
    runs: Array<{ id: number }>;
    summary: { total: number };
    hasMore: boolean;
  };
  assert.equal(body1.runs.length, 2, "limit=2 must cap the page at 2 rows");
  assert.equal(body1.summary.total, 3, "summary.total must reflect the org-wide count, not the page count");
  assert.equal(body1.hasMore, true, "hasMore must be true while more rows remain past the page");

  // Page 2: limit 2, offset 2.
  const page2 = await fetch(`${BASE}/runs?limit=2&offset=2`, { headers: auth() });
  const body2 = (await page2.json()) as {
    runs: Array<{ id: number }>;
    hasMore: boolean;
  };
  assert.equal(body2.runs.length, 1, "the third run lands on page 2 (1 of remaining 1)");
  assert.equal(body2.hasMore, false, "hasMore must be false on the last page");

  // No overlap between pages.
  const page1Ids = new Set(body1.runs.map((r) => r.id));
  const page2Ids = new Set(body2.runs.map((r) => r.id));
  for (const id of page2Ids) {
    assert.ok(!page1Ids.has(id), `run id ${id} appears on both pages — pagination must be contiguous, not overlapping`);
  }
});

// ── 2. /runs/environments distinct values ────────────────────────────

test("GET /runs/environments returns distinct non-empty environments for the caller's org", async () => {
  // Upload runs into a fresh suite with two distinct env values
  // and one empty-env value. The route must return only the two
  // non-empty distincts.
  await uploadRun({ suite: "env-test", ciRunId: `env-qa-${Date.now()}`, environment: "qa" });
  await uploadRun({ suite: "env-test", ciRunId: `env-stage-${Date.now()}`, environment: "stage" });
  await uploadRun({ suite: "env-test", ciRunId: `env-empty-${Date.now()}`, environment: "" });
  // Duplicate of "qa" — dedup must drop it.
  await uploadRun({ suite: "env-test", ciRunId: `env-qa2-${Date.now()}`, environment: "qa" });

  const res = await fetch(`${BASE}/runs/environments`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { environments: string[] };
  assert.deepEqual(
    [...body.environments].sort(),
    ["qa", "stage"],
    "must return DISTINCT non-empty environments — empty strings are filtered, duplicates collapse",
  );
});

// ── 3. /runs/check CI auto-cancellation predicate ────────────────────

test("GET /runs/check returns should_cancel=true when failed count >= threshold, false otherwise", async () => {
  const ciId = `check-${Date.now()}`;
  // Upload a run with 4 failed tests under the shared ci_run_id.
  await uploadRun({ suite: "check", ciRunId: ciId, passed: 1, failed: 4 });

  // threshold=3 → failed (4) >= threshold → cancel.
  const cancel = await fetch(`${BASE}/runs/check?ci_run_id=${ciId}&threshold=3`, {
    headers: auth(),
  });
  assert.equal(cancel.status, 200);
  const cancelBody = (await cancel.json()) as {
    should_cancel: boolean; failed: number; threshold: number; run_id: number | null;
  };
  assert.equal(
    cancelBody.should_cancel,
    true,
    "4 failures with threshold 3 must should_cancel=true — the CI workflow short-circuits on this",
  );
  assert.equal(cancelBody.failed, 4);
  assert.equal(cancelBody.threshold, 3);
  assert.ok(cancelBody.run_id, "run_id must be returned so the CI workflow can link to the failing run");

  // threshold=10 → 4 < 10 → don't cancel.
  const ok = await fetch(`${BASE}/runs/check?ci_run_id=${ciId}&threshold=10`, {
    headers: auth(),
  });
  const okBody = (await ok.json()) as { should_cancel: boolean };
  assert.equal(
    okBody.should_cancel,
    false,
    "4 failures with threshold 10 must should_cancel=false — only the threshold-crossing case trips",
  );
});

test("GET /runs/check returns 400 without ci_run_id (the load-bearing query param)", async () => {
  const res = await fetch(`${BASE}/runs/check?threshold=3`, { headers: auth() });
  assert.equal(res.status, 400, "missing ci_run_id must 400 — the CI workflow always supplies it");
});

test("GET /runs/check with an unknown ci_run_id returns should_cancel=false (graceful zero-state)", async () => {
  // A CI workflow calling /runs/check on its very first shard
  // hasn't uploaded any run yet under that ci_run_id. The route
  // must return should_cancel=false / run_id=null, not 404 — the
  // workflow expects a clean "nothing to cancel" answer.
  const res = await fetch(`${BASE}/runs/check?ci_run_id=does-not-exist-${Date.now()}&threshold=3`, {
    headers: auth(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { should_cancel: boolean; failed: number; run_id: number | null };
  assert.equal(body.should_cancel, false);
  assert.equal(body.failed, 0);
  assert.equal(body.run_id, null, "unknown ci_run_id returns run_id=null — workflows treat that as no-cancel");
});
