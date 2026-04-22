/**
 * Integration smoke test for the Phase 9 / 10 routes.
 *
 * Assumes:
 *   - Postgres is running with all migrations applied
 *   - The backend is NOT already running (this test starts and stops it)
 *
 * Run: node --import tsx --test src/tests/phase_9_10.smoke.test.ts
 *   or: pnpm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let runId: number;
let releaseId: number;
let manualTestId: number;

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

async function authPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function authPatch(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function authGet(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function authDelete(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Some live-event side-effects are fire-and-forget on the server, so the
// DB write may not have landed by the time a test reads back. Poll the
// endpoint briefly until the predicate holds (or give up).
async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const start = Date.now();
  let last: T = await fn();
  while (Date.now() - start < timeoutMs) {
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "smoke-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Short stale-run timeout so the abort tests don't have to wait
      // 10 minutes to exercise the auto-abort path.
      FLAKEY_LIVE_TIMEOUT_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register a fresh user — unique email per run so we don't collide
  const email = `smoke+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "Smoke", org_name: "SmokeOrg" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`register failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { token: string };
  token = data.token;

  // Create a run so coverage/a11y/visual uploads have a target
  const runRes = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: (() => {
      const fd = new FormData();
      fd.append(
        "payload",
        JSON.stringify({
          meta: {
            suite_name: "smoke",
            branch: "main",
            commit_sha: "abc123",
            ci_run_id: "1",
            started_at: "2026-04-10T00:00:00Z",
            finished_at: "2026-04-10T00:00:10Z",
            reporter: "mochawesome",
          },
          stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 10000 },
          specs: [
            {
              file_path: "a.js",
              title: "a",
              stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 10 },
              tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 10, screenshot_paths: [] }],
            },
          ],
        })
      );
      return fd;
    })(),
  });
  assert.ok(runRes.ok, `run upload failed: ${runRes.status}`);
  runId = ((await runRes.json()) as { id: number }).id;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("jira settings default + update", async () => {
  const get = await authGet("/jira/settings");
  assert.equal(get.status, 200);
  const data = (await get.json()) as { has_api_token: boolean; jira_issue_type: string };
  assert.equal(data.has_api_token, false);
  assert.equal(data.jira_issue_type, "Bug");

  const patch = await authPatch("/jira/settings", {
    base_url: "https://x.atlassian.net",
    email: "a@b.com",
    api_token: "tok",
    project_key: "QA",
  });
  assert.equal(patch.status, 200);

  const after = await authGet("/jira/settings");
  const afterData = (await after.json()) as { has_api_token: boolean; jira_base_url: string };
  assert.equal(afterData.has_api_token, true);
  assert.equal(afterData.jira_base_url, "https://x.atlassian.net");
});

test("pagerduty settings update", async () => {
  const patch = await authPatch("/pagerduty/settings", {
    integration_key: "pd-test-key",
    severity: "warning",
    auto_trigger: true,
  });
  assert.equal(patch.status, 200);
  const get = await authGet("/pagerduty/settings");
  const data = (await get.json()) as { has_key: boolean; pagerduty_severity: string; pagerduty_auto_trigger: boolean };
  assert.equal(data.has_key, true);
  assert.equal(data.pagerduty_severity, "warning");
  assert.equal(data.pagerduty_auto_trigger, true);
});

test("scheduled reports CRUD", async () => {
  const create = await authPost("/reports", {
    name: "Daily",
    cadence: "daily",
    hour_utc: 9,
    channel: "webhook",
    destination: "https://example.com/hook",
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number; active: boolean };
  assert.equal(created.active, true);

  const patch = await authPatch(`/reports/${created.id}`, { active: false });
  assert.equal(patch.status, 200);

  const list = await authGet("/reports");
  const rows = (await list.json()) as Array<{ id: number; active: boolean }>;
  assert.equal(rows.find((r) => r.id === created.id)!.active, false);

  const del = await fetch(`${BASE}/reports/${created.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(del.status, 200);
});

test("coverage upload + retrieval", async () => {
  const res = await authPost("/coverage", {
    run_id: runId,
    lines_pct: 82.5,
    branches_pct: 76.2,
    functions_pct: 90.0,
    statements_pct: 82.5,
    lines_covered: 1650,
    lines_total: 2000,
  });
  assert.equal(res.status, 201);

  const get = await authGet(`/coverage/runs/${runId}`);
  assert.equal(get.status, 200);
  const data = (await get.json()) as { lines_pct: string };
  assert.equal(parseFloat(data.lines_pct), 82.5);
});

test("a11y upload scoring", async () => {
  const res = await authPost("/a11y", {
    run_id: runId,
    url: "/",
    violations: [
      { id: "label", impact: "critical" },
      { id: "contrast", impact: "serious" },
      { id: "region", impact: "moderate" },
    ],
    passes: 10,
    incomplete: 1,
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { score: string; critical_count: number; serious_count: number; moderate_count: number };
  // 100 - 15 crit - 8 serious - 4 moderate = 73
  assert.equal(parseFloat(data.score), 73);
  assert.equal(data.critical_count, 1);
  assert.equal(data.serious_count, 1);
  assert.equal(data.moderate_count, 1);
});

test("visual diffs create + review", async () => {
  const res = await authPost("/visual", {
    run_id: runId,
    diffs: [
      { name: "header", diff_pct: 0.15, status: "changed" },
      { name: "footer", diff_pct: 0, status: "unchanged" },
    ],
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { created: Array<{ id: number; status: string }> };
  assert.equal(data.created.length, 2);

  const headerId = data.created.find((d) => d.status === "changed")!.id;
  const patch = await authPatch(`/visual/${headerId}`, { status: "approved" });
  assert.equal(patch.status, 200);

  const list = await authGet(`/visual/runs/${runId}`);
  const diffs = (await list.json()) as Array<{ id: number; status: string }>;
  assert.equal(diffs.find((d) => d.id === headerId)!.status, "approved");
});

test("ui coverage summary + untested", async () => {
  const routes = await authPost("/ui-coverage/routes", {
    routes: ["/a", "/b", "/c"],
  });
  assert.equal(routes.status, 201);

  const visits = await authPost("/ui-coverage/visits", {
    suite_name: "smoke",
    visits: ["/a", "/b"],
  });
  assert.equal(visits.status, 201);

  const summary = await authGet("/ui-coverage/summary");
  const data = (await summary.json()) as { known_routes: number; known_covered: number; coverage_pct: number };
  assert.equal(data.known_routes, 3);
  assert.equal(data.known_covered, 2);
  assert.equal(data.coverage_pct, 66.7);

  const untested = await authGet("/ui-coverage/untested");
  const rows = (await untested.json()) as Array<{ route_pattern: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route_pattern, "/c");
});

test("manual tests CRUD + result recording", async () => {
  const create = await authPost("/manual-tests", {
    title: "Smoke test login flow",
    suite_name: "regression",
    priority: "high",
    steps: [{ action: "Open /login" }, { action: "Submit credentials" }],
    expected_result: "Redirect to /dashboard",
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number; status: string };
  assert.equal(created.status, "not_run");
  manualTestId = created.id;

  const result = await authPost(`/manual-tests/${manualTestId}/result`, {
    status: "passed",
    notes: "Smooth",
  });
  assert.equal(result.status, 200);

  const detail = await authGet(`/manual-tests/${manualTestId}`);
  const data = (await detail.json()) as { status: string; last_run_notes: string };
  assert.equal(data.status, "passed");
  assert.equal(data.last_run_notes, "Smooth");

  const summary = await authGet("/manual-tests/summary");
  const s = (await summary.json()) as { passed: number };
  assert.ok(s.passed >= 1);
});

test("release checklist + sign-off enforcement", async () => {
  // Use an explicit checklist so the auto-ruled items from the default
  // aren't in the picture — they can't be toggled manually and their
  // evaluation depends on runs/sessions that this release doesn't have.
  const create = await authPost("/releases", {
    version: "v0.1.0-smoke",
    name: "Smoke release",
    target_date: "2026-12-31",
    items: [
      { label: "Release notes drafted", required: true },
      { label: "Stakeholders notified", required: true },
      { label: "Documentation updated", required: false },
    ],
  });
  assert.equal(create.status, 201);
  releaseId = ((await create.json()) as { id: number }).id;

  const detail = await authGet(`/releases/${releaseId}`);
  const data = (await detail.json()) as { items: Array<{ id: number; required: boolean; checked: boolean }> };
  assert.equal(data.items.length, 3);

  // Attempt sign-off while items are unchecked — should fail
  const fail = await authPost(`/releases/${releaseId}/sign-off`, {});
  assert.equal(fail.status, 400);

  // Check all required items
  for (const item of data.items) {
    if (item.required) {
      await authPatch(`/releases/${releaseId}/items/${item.id}`, { checked: true });
    }
  }

  // Now sign-off should succeed
  const ok = await authPost(`/releases/${releaseId}/sign-off`, {});
  assert.equal(ok.status, 200);

  const after = await authGet(`/releases/${releaseId}`);
  const afterData = (await after.json()) as { status: string; signed_off_at: string | null };
  assert.equal(afterData.status, "signed_off");
  assert.ok(afterData.signed_off_at);
});

// ─── Manual test groups + bulk-link ─────────────────────────────────────
test("manual test groups: create, assign test, bulk-link to release", async () => {
  // Create a group
  const created = await authPost("/manual-test-groups", {
    name: `Smoke group ${Date.now()}`,
    description: "Covers login + signup",
  });
  assert.equal(created.status, 201);
  const group = (await created.json()) as { id: number; name: string };

  // Rename the group
  const renamed = await authPatch(`/manual-test-groups/${group.id}`, {
    description: "Updated description",
  });
  assert.equal(renamed.status, 200);

  // Put an existing manual test in the group
  const update = await authPatch(`/manual-tests/${manualTestId}`, {
    group_id: group.id,
  });
  assert.equal(update.status, 200);

  // The list endpoint should now return the test under the group filter
  const listed = await authGet(`/manual-tests?group_id=${group.id}`);
  const rows = (await listed.json()) as Array<{ id: number; group_id: number | null; group_name: string | null }>;
  assert.ok(rows.some((r) => r.id === manualTestId && r.group_id === group.id));

  // Create a fresh release for the bulk-link flow (the existing one is
  // already signed off and would add noise to later tests).
  const rel = await authPost("/releases", {
    version: "v0.2.0-groups",
    name: "Groups smoke",
  });
  assert.equal(rel.status, 201);
  const { id: bulkReleaseId } = (await rel.json()) as { id: number };

  // Bulk-link the group's tests into the release
  const linkRes = await authPost(
    `/releases/${bulkReleaseId}/manual-test-groups/${group.id}`,
    {}
  );
  assert.equal(linkRes.status, 200);
  const linked = (await linkRes.json()) as { linked: number; total_in_group: number };
  assert.equal(linked.total_in_group, 1);
  assert.equal(linked.linked, 1);

  // Re-linking is idempotent (0 new links, group size unchanged)
  const reLink = await authPost(
    `/releases/${bulkReleaseId}/manual-test-groups/${group.id}`,
    {}
  );
  const reLinked = (await reLink.json()) as { linked: number; total_in_group: number };
  assert.equal(reLinked.linked, 0);
  assert.equal(reLinked.total_in_group, 1);
});

// ─── Release test sessions + result recording + accept-known-issue ──────
test("release sessions: create, record, fail, accept, auto-complete", async () => {
  // New release so we don't collide with sign-off test
  const rel = await authPost("/releases", {
    version: "v0.3.0-sessions",
    name: "Sessions smoke",
  });
  const { id: sessionReleaseId } = (await rel.json()) as { id: number };

  // Link the one manual test we have from earlier
  const link = await authPost(`/releases/${sessionReleaseId}/manual-tests`, {
    manual_test_ids: [manualTestId],
  });
  assert.equal(link.status, 200);

  // Starting a session with no target-date, full mode
  const create = await authPost(`/releases/${sessionReleaseId}/sessions`, {
    label: "Initial pass",
    mode: "full",
    target_date: "2026-12-01",
  });
  assert.equal(create.status, 201);
  const session = (await create.json()) as {
    id: number;
    session_number: number;
    status: string;
    target_date: string | null;
    seeded: number;
  };
  assert.equal(session.session_number, 1);
  assert.equal(session.status, "in_progress");
  assert.equal(session.seeded, 1);
  assert.ok(session.target_date);

  // Creating a second session while one is in_progress should 409
  const dup = await authPost(`/releases/${sessionReleaseId}/sessions`, {
    mode: "full",
  });
  assert.equal(dup.status, 409);

  // Record the result as failed — session should still be in_progress
  // because only one test was seeded and it's now in a terminal state,
  // which means auto-complete kicks in. Verify that branch.
  const record = await authPost(
    `/releases/${sessionReleaseId}/sessions/${session.id}/results/${manualTestId}`,
    { status: "failed", notes: "Smoke check failed" }
  );
  assert.equal(record.status, 200);
  const recordBody = (await record.json()) as { updated: boolean; session_completed: boolean };
  assert.equal(recordBody.updated, true);
  // Only one result in scope → session should auto-complete once it reaches a terminal state
  assert.equal(recordBody.session_completed, true);

  // Accept the failure as a known issue
  const accept = await authPost(
    `/releases/${sessionReleaseId}/sessions/${session.id}/results/${manualTestId}/accept`,
    { known_issue_ref: "ABC-999" }
  );
  assert.equal(accept.status, 200);

  // Detail should reflect acceptance
  const detail = await authGet(`/releases/${sessionReleaseId}/sessions/${session.id}`);
  const detailBody = (await detail.json()) as {
    results: Array<{ manual_test_id: number; accepted_as_known_issue: boolean; known_issue_ref: string | null }>;
  };
  const res = detailBody.results.find((r) => r.manual_test_id === manualTestId)!;
  assert.ok(res);
  assert.equal(res.accepted_as_known_issue, true);
  assert.equal(res.known_issue_ref, "ABC-999");

  // Readiness rule should now be met because the only failure is accepted
  const readiness = await authGet(`/releases/${sessionReleaseId}/readiness`);
  const readyBody = (await readiness.json()) as {
    rules: Record<string, { met: boolean; details: string }>;
    manual_tests: { passed: number; failed: number; accepted: number; linked: number };
  };
  const rule = readyBody.rules.manual_regression_executed;
  assert.equal(rule.met, true, `expected rule to be met, details: ${rule.details}`);
  assert.match(rule.details, /accepted/);
  assert.equal(readyBody.manual_tests.accepted, 1);

  // Revoke acceptance → rule should go back to unmet
  const revoke = await authDelete(
    `/releases/${sessionReleaseId}/sessions/${session.id}/results/${manualTestId}/accept`
  );
  assert.equal(revoke.status, 200);
  const readiness2 = await authGet(`/releases/${sessionReleaseId}/readiness`);
  const readyBody2 = (await readiness2.json()) as {
    rules: Record<string, { met: boolean; details: string }>;
  };
  assert.equal(readyBody2.rules.manual_regression_executed.met, false);

  // Starting a failures_only session should seed the revoked failure
  const rerun = await authPost(`/releases/${sessionReleaseId}/sessions`, {
    label: "Rerun failures",
    mode: "failures_only",
  });
  assert.equal(rerun.status, 201);
  const rerunBody = (await rerun.json()) as { session_number: number; mode: string; seeded: number };
  assert.equal(rerunBody.session_number, 2);
  assert.equal(rerunBody.mode, "failures_only");
  assert.equal(rerunBody.seeded, 1);
});

// ─── Requirements traceability ──────────────────────────────────────────
test("manual test requirements: link, rollup, unlink", async () => {
  // Attach a Jira requirement to our existing manual test
  const add = await authPost(`/manual-tests/${manualTestId}/requirements`, {
    ref_key: "ACME-777",
    ref_url: "https://example.atlassian.net/browse/ACME-777",
    ref_title: "Smoke requirement",
  });
  assert.equal(add.status, 201);
  const req = (await add.json()) as { id: number; provider: string };
  // Provider inferred from Atlassian URL
  assert.equal(req.provider, "jira");

  // Requirement shows up in the test detail response
  const detail = await authGet(`/manual-tests/${manualTestId}`);
  const detailBody = (await detail.json()) as {
    requirements: Array<{ ref_key: string }>;
    requirement_count?: number;
  };
  assert.ok(detailBody.requirements.some((r) => r.ref_key === "ACME-777"));

  // Unlink
  const del = await authDelete(`/manual-tests/${manualTestId}/requirements/${req.id}`);
  assert.equal(del.status, 200);
});

// ─── Live-run abort: explicit endpoint ──────────────────────────────────
test("live run abort: POST /abort emits run.aborted and clears active set", async () => {
  const start = await authPost("/live/start", { suite: "smoke-abort-explicit" });
  assert.equal(start.status, 201);
  const { id: runId } = (await start.json()) as { id: number };

  // Run should show up in the active set
  const active1 = await authGet("/live/active");
  const active1Body = (await active1.json()) as { runs: number[] };
  assert.ok(active1Body.runs.includes(runId), "run should be active after /live/start");

  // Explicit abort
  const abort = await authPost(`/live/${runId}/abort`, {
    reason: "Smoke test — explicit abort",
  });
  assert.equal(abort.status, 200);

  // Active set should no longer include the run
  const active2 = await authGet("/live/active");
  const active2Body = (await active2.json()) as { runs: number[] };
  assert.ok(!active2Body.runs.includes(runId), "run should leave active after abort");

  // History should contain the persisted run.aborted event with our reason.
  // persistEvent is fire-and-forget so poll until it lands.
  const events = await waitFor(
    async () => {
      const h = await authGet(`/live/${runId}/history`);
      return (await h.json()) as Array<{ type: string; error?: string | null }>;
    },
    (list) => list.some((e) => e.type === "run.aborted")
  );
  const aborted = events.find((e) => e.type === "run.aborted");
  assert.ok(aborted, "history should include run.aborted event");
  assert.equal(aborted!.error, "Smoke test — explicit abort");
});

// ─── Live-run abort: stale timeout path ─────────────────────────────────
test("live run abort: stale runs get auto-aborted after timeout", async () => {
  const start = await authPost("/live/start", { suite: "smoke-abort-stale" });
  const { id: runId } = (await start.json()) as { id: number };

  // Wait longer than FLAKEY_LIVE_TIMEOUT_MS (1500ms) + check cadence (~375ms)
  // so the stale detector definitely fires.
  await new Promise((r) => setTimeout(r, 2500));

  // Active set should no longer include the run
  const active = await authGet("/live/active");
  const activeBody = (await active.json()) as { runs: number[] };
  assert.ok(!activeBody.runs.includes(runId), "stale run should be auto-aborted");

  // History should include the persisted run.aborted event (fire-and-forget)
  const events = await waitFor(
    async () => {
      const h = await authGet(`/live/${runId}/history`);
      return (await h.json()) as Array<{ type: string }>;
    },
    (list) => list.some((e) => e.type === "run.aborted")
  );
  assert.ok(events.some((e) => e.type === "run.aborted"), "run.aborted must land in history");
});

// ─── Runs list exposes aborted flag ─────────────────────────────────────
test("GET /runs marks aborted runs with aborted=true", async () => {
  const start = await authPost("/live/start", { suite: "smoke-abort-flag" });
  const { id: runId } = (await start.json()) as { id: number };
  await authPost(`/live/${runId}/abort`, { reason: "flag test" });

  // The aborted flag is derived from live_events, which are written async,
  // so poll until the list reflects the abort.
  const runs = await waitFor(
    async () => {
      const l = await authGet("/runs?limit=100");
      const body = (await l.json()) as { runs: Array<{ id: number; aborted?: boolean }> };
      return body.runs;
    },
    (rs) => !!rs.find((r) => r.id === runId)?.aborted
  );
  const row = runs.find((r) => r.id === runId);
  assert.ok(row, "aborted run should appear in /runs");
  assert.equal(row!.aborted, true, "aborted flag should propagate from live_events");

  const detail = await authGet(`/runs/${runId}`);
  const detailBody = (await detail.json()) as { aborted?: boolean; aborted_reason?: string };
  assert.equal(detailBody.aborted, true);
  assert.equal(detailBody.aborted_reason, "flag test");
});

// ─── Live snapshot endpoint: happy path + sanitization + foreign runId ───
test("POST /live/:runId/snapshot stores blob, sanitizes filename, links test row, rejects foreign run", async () => {
  // Create a live run
  const start = await authPost("/live/start", { suite: "smoke-snapshot" });
  assert.equal(start.status, 201);
  const { id: liveRunId } = (await start.json()) as { id: number };

  // Emit test.started for a specific full_title so the UPDATE has something to match
  const spec = "cypress/e2e/login.cy.ts";
  const fullTitle = "Login flow should redirect after logout";
  const evt = await authPost(`/live/${liveRunId}/events`, [
    { type: "test.started", spec, test: fullTitle },
  ]);
  assert.equal(evt.status, 200);

  // Wait for the pending row to land (backend processes events after response)
  await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      const body = (await d.json()) as { specs?: Array<{ tests?: Array<{ full_title: string }> }> };
      return body.specs?.flatMap((s) => s.tests ?? []) ?? [];
    },
    (rows) => rows.some((r) => r.full_title === fullTitle)
  );

  // Missing required field → 400
  {
    const fd = new FormData();
    fd.set("snapshot", new Blob(["x"], { type: "application/gzip" }), "bad.gz");
    // no spec / testTitle
    const r = await fetch(`${BASE}/live/${liveRunId}/snapshot`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    assert.equal(r.status, 400);
  }

  // Happy path: upload gz blob, assert key + snapshot_path linkage
  const gzBody = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const fd = new FormData();
  fd.set("snapshot", new Blob([gzBody], { type: "application/gzip" }), "snapshot.json.gz");
  fd.set("spec", spec);
  fd.set("testTitle", fullTitle);
  const ok = await fetch(`${BASE}/live/${liveRunId}/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  assert.equal(ok.status, 200);
  const { key } = (await ok.json()) as { key: string };
  assert.ok(key.startsWith(`runs/${liveRunId}/snapshots/`), `key should be run-scoped, got: ${key}`);
  assert.match(key, /login\.cy\.ts--Login-flow-should-redirect-after-logout\.json\.gz$/);

  // snapshot_path should propagate to the tests row (UPDATE runs right after put)
  const tests = await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      const body = (await d.json()) as { specs?: Array<{ tests?: Array<{ full_title: string; snapshot_path?: string | null }> }> };
      return body.specs?.flatMap((s) => s.tests ?? []) ?? [];
    },
    (rows) => !!rows.find((r) => r.full_title === fullTitle)?.snapshot_path
  );
  const linked = tests.find((r) => r.full_title === fullTitle);
  assert.equal(linked?.snapshot_path, key, "tests.snapshot_path should match the uploaded key");

  // Filename sanitization: testTitle with path-traversal and angle brackets
  {
    const fd2 = new FormData();
    fd2.set("snapshot", new Blob([gzBody], { type: "application/gzip" }), "evil.json.gz");
    fd2.set("spec", spec);
    fd2.set("testTitle", "../../evil <script>");
    const r = await fetch(`${BASE}/live/${liveRunId}/snapshot`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd2,
    });
    assert.equal(r.status, 200);
    const { key: evilKey } = (await r.json()) as { key: string };
    assert.ok(!evilKey.includes(".."), `key must not contain traversal: ${evilKey}`);
    assert.ok(!evilKey.includes("<"), `key must not contain angle brackets: ${evilKey}`);
  }

  // Foreign runId: a run belonging to no one (e.g. 999999) must 404
  {
    const fd3 = new FormData();
    fd3.set("snapshot", new Blob([gzBody], { type: "application/gzip" }), "a.json.gz");
    fd3.set("spec", spec);
    fd3.set("testTitle", fullTitle);
    const r = await fetch(`${BASE}/live/999999/snapshot`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd3,
    });
    assert.equal(r.status, 404);
  }
});

// ─── Live test-row upsert: duplicate test.started is idempotent ────────
test("two identical test.started events produce one tests row (idempotent upsert)", async () => {
  const start = await authPost("/live/start", { suite: "smoke-upsert-idempotent" });
  const { id: liveRunId } = (await start.json()) as { id: number };

  const spec = "cypress/e2e/dup.cy.ts";
  const fullTitle = "Dup suite > only one row please";

  await authPost(`/live/${liveRunId}/events`, [{ type: "test.started", spec, test: fullTitle }]);
  await authPost(`/live/${liveRunId}/events`, [{ type: "test.started", spec, test: fullTitle }]);

  const rows = await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      const body = (await d.json()) as { specs?: Array<{ tests?: Array<{ full_title: string }> }> };
      return body.specs?.flatMap((s) => s.tests ?? []) ?? [];
    },
    (r) => r.filter((x) => x.full_title === fullTitle).length > 0
  );
  const matching = rows.filter((r) => r.full_title === fullTitle);
  assert.equal(matching.length, 1, "duplicate test.started must not produce duplicate rows");
});

// ─── Live stats: pending → passed updates counters correctly ───────────
test("test.started then test.passed transitions pending → passed in run totals", async () => {
  const start = await authPost("/live/start", { suite: "smoke-pending-transition" });
  const { id: liveRunId } = (await start.json()) as { id: number };

  const spec = "cypress/e2e/trans.cy.ts";
  const fullTitle = "Trans suite > it passes";

  await authPost(`/live/${liveRunId}/events`, [{ type: "test.started", spec, test: fullTitle }]);

  // After test.started, the test row has status='pending' which counts under skipped
  const mid = await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      return (await d.json()) as { passed: number; failed: number; skipped: number; total: number };
    },
    (r) => r.total >= 1
  );
  assert.equal(mid.passed, 0, "no passed yet");
  assert.equal(mid.failed, 0);
  assert.ok(mid.skipped >= 1, `pending should count as skipped mid-run, got ${mid.skipped}`);

  // Now send test.passed — pending row should transition, passed should tick up
  await authPost(`/live/${liveRunId}/events`, [
    { type: "test.passed", spec, test: fullTitle, duration_ms: 123 },
  ]);

  const final = await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      return (await d.json()) as { passed: number; failed: number; skipped: number; total: number };
    },
    (r) => r.passed === 1
  );
  assert.equal(final.passed, 1, "passed should increment after test.passed");
  assert.equal(final.failed, 0);
  assert.equal(final.skipped, 0, "pending bucket should drain when test finishes");
});

// ─── Spec upsert on /runs upload ──────────────────────────────────────
// Cucumber-style reporters only emit spec.started/spec.finished (no per-test
// events), so the live path creates a specs row with stats from the
// spec.finished payload but zero tests rows. The reporter then POSTs /runs
// at after:run with the full per-test list. Before the fix, that INSERT
// collided with uniq_specs_run_file (migration 030) and the whole
// transaction rolled back — summary showed N total but the list was empty.
test("live spec row + later /runs upload merges instead of rolling back on unique conflict", async () => {
  const suite = `smoke-upload-after-live-${Date.now()}`;
  const start = await authPost("/live/start", { suite });
  assert.equal(start.status, 201);
  const { id: liveRunId, ci_run_id } = (await start.json()) as { id: number; ci_run_id: string };

  const specPath = "cypress/e2e/cucumber.feature";

  // Live path: simulate Cucumber reporter that only emits spec-level events.
  await authPost(`/live/${liveRunId}/events`, [
    { type: "spec.started", spec: specPath },
    { type: "spec.finished", spec: specPath, stats: { total: 3, passed: 2, failed: 1, skipped: 0, duration_ms: 500 } },
  ]);

  // Wait for the live path to populate spec stats.
  await waitFor(
    async () => {
      const d = await authGet(`/runs/${liveRunId}`);
      return (await d.json()) as { total: number; specs: Array<{ total: number; tests: unknown[] }> };
    },
    (r) => r.specs.length === 1 && r.specs[0].total === 3
  );

  // After:run — reporter posts the authoritative per-test list. This has the
  // same (run_id, file_path) as the live-created spec, which used to crash
  // on uniq_specs_run_file.
  const uploadRes = await authPost("/runs", {
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id,
      started_at: "2026-04-17T00:00:00Z",
      finished_at: "2026-04-17T00:00:01Z",
      reporter: "cypress",
    },
    stats: { total: 3, passed: 2, failed: 1, skipped: 0, pending: 0, duration_ms: 500 },
    specs: [
      {
        file_path: specPath,
        title: "cucumber.feature",
        stats: { total: 3, passed: 2, failed: 1, skipped: 0, duration_ms: 500 },
        tests: [
          { title: "scenario A", full_title: "cucumber > scenario A", status: "passed", duration_ms: 100, screenshot_paths: [] },
          { title: "scenario B", full_title: "cucumber > scenario B", status: "passed", duration_ms: 150, screenshot_paths: [] },
          { title: "scenario C", full_title: "cucumber > scenario C", status: "failed", duration_ms: 200, screenshot_paths: [], error: { message: "boom" } },
        ],
      },
    ],
  });
  assert.equal(uploadRes.status, 200, `expected merge (200), got ${uploadRes.status}`);
  const uploadBody = (await uploadRes.json()) as { id: number; merged: boolean };
  assert.equal(uploadBody.id, liveRunId, "upload must merge into the live run");
  assert.equal(uploadBody.merged, true);

  // Run detail should now have 3 test rows visible — the symptom was 0 rows.
  const detail = (await (await authGet(`/runs/${liveRunId}`)).json()) as {
    total: number; failed: number;
    specs: Array<{ total: number; tests: Array<{ full_title: string; status: string }> }>;
  };
  assert.equal(detail.specs.length, 1);
  assert.equal(detail.specs[0].tests.length, 3, "test list must not be empty after upload merges over a live-created spec");
  assert.equal(detail.specs[0].total, 3);
  assert.equal(detail.total, 3);
  assert.equal(detail.failed, 1);
  const titles = detail.specs[0].tests.map((t) => t.full_title).sort();
  assert.deepEqual(titles, ["cucumber > scenario A", "cucumber > scenario B", "cucumber > scenario C"]);
});

test("upload with meta.release upserts release and links run", async () => {
  const version = `v-upload-${Date.now()}`;

  const res1 = await authPost("/runs", {
    meta: {
      suite_name: "release-link-smoke",
      branch: "main",
      commit_sha: "rel-sha-1",
      ci_run_id: "rel-ci-1",
      started_at: "2026-04-21T00:00:00Z",
      finished_at: "2026-04-21T00:00:05Z",
      reporter: "mochawesome",
      release: version,
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 5 },
    specs: [
      {
        file_path: "rel.js",
        title: "rel",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 5 },
        tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 5, screenshot_paths: [] }],
      },
    ],
  });
  assert.ok(res1.ok, `first upload failed: ${res1.status}`);
  const firstRunId = ((await res1.json()) as { id: number }).id;

  // Release must exist and contain the run.
  const list = (await (await authGet("/releases")).json()) as { id: number; version: string }[];
  const rel = list.find((r) => r.version === version);
  assert.ok(rel, `release ${version} must appear in /releases`);
  const detail = (await (await authGet(`/releases/${rel!.id}`)).json()) as { linked_runs?: { id: number }[] };
  assert.ok(detail.linked_runs?.some((r) => r.id === firstRunId), "run must be linked via release_runs");

  // Second upload with the SAME release name must not create a duplicate
  // release row — it must reuse the existing release and link the new run.
  const res2 = await authPost("/runs", {
    meta: {
      suite_name: "release-link-smoke-2",
      branch: "main",
      commit_sha: "rel-sha-2",
      ci_run_id: "rel-ci-2",
      started_at: "2026-04-21T00:01:00Z",
      finished_at: "2026-04-21T00:01:05Z",
      reporter: "mochawesome",
      release: version,
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 5 },
    specs: [
      {
        file_path: "rel2.js",
        title: "rel2",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 5 },
        tests: [{ title: "t2", full_title: "t2", status: "passed", duration_ms: 5, screenshot_paths: [] }],
      },
    ],
  });
  assert.ok(res2.ok);
  const secondRunId = ((await res2.json()) as { id: number }).id;

  const list2 = (await (await authGet("/releases")).json()) as { id: number; version: string }[];
  const matching = list2.filter((r) => r.version === version);
  assert.equal(matching.length, 1, "no duplicate release row should be created for the same version");

  const detail2 = (await (await authGet(`/releases/${matching[0].id}`)).json()) as { linked_runs?: { id: number }[] };
  const linkedIds = (detail2.linked_runs ?? []).map((r) => r.id).sort();
  assert.ok(linkedIds.includes(firstRunId) && linkedIds.includes(secondRunId), "both runs must be linked");
});

test("upload without meta.release does not create a release row", async () => {
  const beforeCount = ((await (await authGet("/releases")).json()) as unknown[]).length;

  const res = await authPost("/runs", {
    meta: {
      suite_name: "no-release",
      branch: "main",
      commit_sha: "x",
      ci_run_id: "x",
      started_at: "2026-04-21T00:02:00Z",
      finished_at: "2026-04-21T00:02:05Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 5 },
    specs: [
      {
        file_path: "norel.js",
        title: "norel",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 5 },
        tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 5, screenshot_paths: [] }],
      },
    ],
  });
  assert.ok(res.ok);

  const afterCount = ((await (await authGet("/releases")).json()) as unknown[]).length;
  assert.equal(afterCount, beforeCount, "release count unchanged for upload without release");
});
