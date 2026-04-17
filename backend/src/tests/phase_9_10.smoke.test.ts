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
