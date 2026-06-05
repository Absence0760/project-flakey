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
  // Override the auth token so a test can drive a freshly-registered org
  // with predictable, un-polluted org-wide summary counts.
  token?: string;
};

// Register a fresh org so org-wide summary counts are predictable (the
// shared `token` org accumulates runs across every test in this file).
// Returns the org's token and slug (slug powers the public badge route).
async function registerOrg(): Promise<{ token: string; slug: string }> {
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `runs-fresh+${Date.now()}-${Math.round(performance.now())}@test.local`,
      password: "testpass123",
      name: "Runs Fresh",
      org_name: `RunsFreshOrg-${Date.now()}-${Math.round(performance.now())}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const freshToken = ((await reg.json()) as { token: string }).token;
  const me = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  const slug = ((await me.json()) as { orgs: Array<{ slug: string }> }).orgs[0].slug;
  return { token: freshToken, slug };
}

// Start a live (in-progress) run via /live/start. It inserts a run row with
// finished_at = NULL and failed = 0 and never uploads, mimicking a sharded
// suite mid-flight.
async function liveStart(suite: string, ciRunId: string, authToken: string): Promise<number> {
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ suite, ciRunId }),
  });
  if (!res.ok) throw new Error(`live/start failed: ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

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
    headers: { Authorization: `Bearer ${opts.token ?? token}` },
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

// ── 4. /runs summary excludes in-progress runs from the pass count ───
//
// The release-manager gate trusts summary.passed to mean "completed, no
// failures". A live run (POST /live/start, finished_at NULL, failed=0)
// must NOT inflate the pass bucket — it belongs in `incomplete`. Run in a
// fresh org so the org-wide counts are exact.

test("GET /runs summary: a live (in-progress) run counts as incomplete, never as passed", async () => {
  const { token: t } = await registerOrg();

  // One genuinely-completed passing run.
  await uploadRun({ suite: "gate", ciRunId: `gate-done-${Date.now()}`, passed: 2, failed: 0, token: t });
  // One live run that never uploads — finished_at stays NULL, failed=0.
  await liveStart("gate-live", `gate-live-${Date.now()}`, t);

  const res = await fetch(`${BASE}/runs`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    summary: { total: number; passed: number; failed: number; incomplete: number };
  };
  assert.equal(body.summary.total, 2, "both runs are in the org");
  assert.equal(body.summary.passed, 1, "only the completed run is a pass — the live run must NOT count as passed");
  assert.equal(body.summary.failed, 0, "no completed run failed");
  assert.equal(body.summary.incomplete, 1, "the live run is incomplete, not passed");
});

// ── 5. Public badge reflects completion/abort state, not a false green ──

test("GET /badge: a suite whose latest run is live renders 'in progress', not green", async () => {
  const { token: t, slug } = await registerOrg();
  // Latest run for this suite is live (finished_at NULL, failed=0). Before
  // the fix this rendered a green '0 passed'/'passed' badge.
  await liveStart("badge-live", `badge-live-${Date.now()}`, t);

  const res = await fetch(`${BASE}/badge/${slug}/badge-live`);
  assert.equal(res.status, 200);
  const svg = await res.text();
  assert.match(svg, /in progress/, "a live run's badge must say 'in progress'");
  assert.ok(!/passed/.test(svg), "a live run's badge must not claim any tests passed");
  assert.ok(!svg.includes("#4c1"), "a live run's badge must not be green (#4c1)");
});

test("GET /badge: a completed all-pass run renders green", async () => {
  const { token: t, slug } = await registerOrg();
  await uploadRun({ suite: "badge-green", ciRunId: `badge-green-${Date.now()}`, passed: 3, failed: 0, token: t });

  const res = await fetch(`${BASE}/badge/${slug}/badge-green`);
  assert.equal(res.status, 200);
  const svg = await res.text();
  assert.match(svg, /3 passed/, "a completed all-pass run shows the pass count");
  assert.ok(svg.includes("#4c1"), "a completed all-pass run is green (#4c1)");
});

// ── 6. /runs/status — consolidated JSON ship signal ──────────────────
//
// The endpoint a CI ship-gate polls instead of composing failed + aborted +
// finished_at itself. Statuses: passed | failed | incomplete | aborted.

async function getStatus(query: string, authToken: string) {
  const res = await fetch(`${BASE}/runs/status?${query}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return res;
}

test("GET /runs/status: a completed all-pass run reports status=passed", async () => {
  const { token: t } = await registerOrg();
  const ciRunId = `status-pass-${Date.now()}`;
  await uploadRun({ suite: "status-pass", ciRunId, passed: 3, failed: 0, token: t });

  const res = await getStatus(`ci_run_id=${ciRunId}`, t);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; run_id: number; failed: number; finished_at: string | null };
  assert.equal(body.status, "passed");
  assert.equal(body.failed, 0);
  assert.ok(body.run_id, "a real run id is returned");
  assert.ok(body.finished_at, "a completed run carries finished_at");
});

test("GET /runs/status: a run with failures reports status=failed", async () => {
  const { token: t } = await registerOrg();
  const ciRunId = `status-fail-${Date.now()}`;
  await uploadRun({ suite: "status-fail", ciRunId, passed: 1, failed: 2, token: t });

  const res = await getStatus(`ci_run_id=${ciRunId}`, t);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; failed: number };
  assert.equal(body.status, "failed");
  assert.equal(body.failed, 2);
});

test("GET /runs/status: a live (in-progress) run reports status=incomplete, never passed", async () => {
  const { token: t } = await registerOrg();
  const ciRunId = `status-live-${Date.now()}`;
  await liveStart("status-live", ciRunId, t);

  const res = await getStatus(`ci_run_id=${ciRunId}`, t);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; finished_at: string | null };
  assert.equal(body.status, "incomplete", "a live run is incomplete, not passed");
  assert.equal(body.finished_at, null, "a live run has no finish time");
});

test("GET /runs/status: identifies the latest run by suite when no ci_run_id is given", async () => {
  const { token: t } = await registerOrg();
  // Two completed runs for the same suite under different ci_run_ids; the
  // status must reflect the latest (the second, with failures).
  await uploadRun({ suite: "status-suite", ciRunId: `status-suite-a-${Date.now()}`, passed: 2, failed: 0, token: t });
  await uploadRun({ suite: "status-suite", ciRunId: `status-suite-b-${Date.now()}`, passed: 1, failed: 1, token: t });

  const res = await getStatus(`suite=status-suite`, t);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; suite_name: string };
  assert.equal(body.suite_name, "status-suite");
  assert.equal(body.status, "failed", "the latest run for the suite carried a failure");
});

test("GET /runs/status: badge and JSON status agree — green iff status=passed", async () => {
  const { token: t, slug } = await registerOrg();

  // Case 1: a live run — status "incomplete", badge "in progress", not green.
  await liveStart("status-agree", `status-agree-${Date.now()}`, t);
  const liveStatus = (await (await getStatus(`suite=status-agree`, t)).json()) as { status: string };
  const liveBadge = await (await fetch(`${BASE}/badge/${slug}/status-agree`)).text();
  assert.equal(liveStatus.status, "incomplete");
  assert.match(liveBadge, /in progress/);
  assert.ok(!liveBadge.includes("#4c1"), "badge must not be green when status is incomplete");

  // Case 2: a completed all-pass run — status "passed", badge green. This is
  // the load-bearing direction: badge is green EXACTLY when status is passed.
  await uploadRun({ suite: "status-agree-pass", ciRunId: `status-agree-pass-${Date.now()}`, passed: 3, failed: 0, token: t });
  const passStatus = (await (await getStatus(`suite=status-agree-pass`, t)).json()) as { status: string };
  const passBadge = await (await fetch(`${BASE}/badge/${slug}/status-agree-pass`)).text();
  assert.equal(passStatus.status, "passed");
  assert.ok(passBadge.includes("#4c1"), "badge must be green exactly when status is passed");
});

test("GET /runs/status: unknown ci_run_id is a 404 (ship gate fails loud / closed)", async () => {
  const { token: t } = await registerOrg();
  const res = await getStatus(`ci_run_id=status-nope-${Date.now()}`, t);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { status?: string };
  assert.equal(body.status, undefined, "no status field on a 404 — a naive jq .status reads null and fails closed");
});

test("GET /runs/status: 400 when neither ci_run_id nor suite is supplied", async () => {
  const { token: t } = await registerOrg();
  const res = await getStatus(``, t);
  assert.equal(res.status, 400);
});
