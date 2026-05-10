// Suite lifecycle smoke — rename → archive/unarchive → rerun-template
// → delete + cascade. The within-org happy paths weren't covered;
// cross_tenant.smoke.test.ts pins the org-isolation invariants but
// not the basic CRUD round-trips that the Settings → Suites page is
// built around.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3973;
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

async function uploadRunIntoSuite(suite: string): Promise<number> {
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: `sha-${suite}-${Date.now()}`,
      ci_run_id: `ci-${suite}-${Date.now()}`,
      started_at: "2026-05-10T00:00:00Z",
      finished_at: "2026-05-10T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [{
      file_path: `${suite}.cy.ts`,
      title: suite,
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 10 },
      tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 10, screenshot_paths: [] }],
    }],
  }));
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

async function listSuites(): Promise<Array<{ suite_name: string; archived: boolean; rerun_command_template: string | null; run_count: number }>> {
  const res = await fetch(`${BASE}/suites`, { headers: auth() });
  if (!res.ok) throw new Error(`GET /suites failed: ${res.status}`);
  return (await res.json()) as Array<{ suite_name: string; archived: boolean; rerun_command_template: string | null; run_count: number }>;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "suite-lifecycle-test-secret",
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
      email: `suite-lifecycle+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Suite Lifecycle",
      org_name: `SuiteLifecycleOrg-${Date.now()}`,
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

// ── Rename: runs follow the new name ────────────────────────────────────

test("PATCH /suites/:name/rename moves the suite's existing runs onto the new name (no orphaned old-name runs)", async () => {
  const oldName = `rename-from-${Date.now()}`;
  const newName = `rename-to-${Date.now()}`;
  await uploadRunIntoSuite(oldName);

  // Sanity: the suite exists under the old name.
  let suites = await listSuites();
  assert.ok(suites.some((s) => s.suite_name === oldName), `pre-rename: ${oldName} must be present`);
  assert.ok(!suites.some((s) => s.suite_name === newName), `pre-rename: ${newName} must not exist`);

  const rename = await fetch(`${BASE}/suites/${encodeURIComponent(oldName)}/rename`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ new_name: newName }),
  });
  assert.equal(rename.status, 200);

  // After rename, the new name has the run; the old name is gone
  // (the run row's suite_name was UPDATEd in place, not duplicated).
  suites = await listSuites();
  const renamedRow = suites.find((s) => s.suite_name === newName);
  assert.ok(renamedRow, "renamed suite must appear under the new name");
  assert.ok(
    !suites.some((s) => s.suite_name === oldName),
    "no orphaned row under the old name — the rename UPDATE must have moved every run",
  );
  assert.equal(renamedRow!.run_count, 1, "run_count must follow the rename");
});

// ── Archive / unarchive round-trip ──────────────────────────────────────

test("PATCH /suites/:name/archive toggles the archived flag on /suites; unarchive flips it back", async () => {
  const suite = `archive-${Date.now()}`;
  await uploadRunIntoSuite(suite);

  // Default state: not archived.
  let suites = await listSuites();
  let row = suites.find((s) => s.suite_name === suite);
  assert.ok(row, "new suite must appear on /suites");
  assert.equal(row!.archived, false, "fresh suite must NOT be archived by default");

  // Archive.
  const archive = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/archive`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archive.status, 200);

  suites = await listSuites();
  row = suites.find((s) => s.suite_name === suite);
  assert.equal(row!.archived, true, "after archive, the flag on /suites must be true");

  // Unarchive (default archived:true on body, but explicit false here).
  const unarchive = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/archive`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ archived: false }),
  });
  assert.equal(unarchive.status, 200);

  suites = await listSuites();
  row = suites.find((s) => s.suite_name === suite);
  assert.equal(row!.archived, false, "unarchive must clear the flag — the suite_overrides row must be UPDATEd, not deleted");
});

// ── Rerun-template round-trip ───────────────────────────────────────────

test("PATCH /suites/:name/rerun-template persists the template and clears on empty string", async () => {
  const suite = `rerun-tpl-${Date.now()}`;
  await uploadRunIntoSuite(suite);

  // Set a template.
  const set = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/rerun-template`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ template: "npm run cy:open -- --spec {spec}" }),
  });
  assert.equal(set.status, 200);

  let suites = await listSuites();
  let row = suites.find((s) => s.suite_name === suite);
  assert.equal(row!.rerun_command_template, "npm run cy:open -- --spec {spec}",
    "rerun template must persist into the suite_overrides row");

  // Clear via empty string — the route stores NULL on empty.
  const clear = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/rerun-template`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ template: "" }),
  });
  assert.equal(clear.status, 200);

  suites = await listSuites();
  row = suites.find((s) => s.suite_name === suite);
  assert.equal(row!.rerun_command_template, null,
    "empty-string template must be persisted as NULL — UI relies on null to render 'no template configured'");
});

// ── Delete cascades runs and clears the override row ────────────────────

test("DELETE /suites/:name removes every run for the suite AND drops the suite_overrides row", async () => {
  const suite = `delete-${Date.now()}`;
  await uploadRunIntoSuite(suite);
  await uploadRunIntoSuite(suite);
  // Set an override (archived + template) so we can verify it
  // also gets cleaned up.
  await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/archive`, {
    method: "PATCH", headers: auth(), body: JSON.stringify({ archived: true }),
  });
  await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/rerun-template`, {
    method: "PATCH", headers: auth(), body: JSON.stringify({ template: "to-be-deleted" }),
  });

  const del = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}`, {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(del.status, 200);
  const body = (await del.json()) as { deleted: boolean; runs_deleted: number };
  assert.equal(body.deleted, true);
  assert.equal(body.runs_deleted, 2, "both runs uploaded into the suite must be deleted");

  // Post-delete: the suite no longer appears on /suites (no runs
  // referencing it AND the override row is gone).
  const suites = await listSuites();
  assert.ok(
    !suites.some((s) => s.suite_name === suite),
    "deleted suite must NOT appear on /suites — neither runs nor suite_overrides should retain the name",
  );
});

// ── Viewer can read /suites but cannot mutate ───────────────────────────

test("/suites lifecycle endpoints all 403 a viewer (admin-only role gate)", async () => {
  // Quick smoke that the role-gate is in place on every mutation
  // endpoint. cross_tenant.smoke.test.ts covers the org isolation;
  // this covers the within-org role gate explicitly.
  const suite = `viewer-attempt-${Date.now()}`;
  await uploadRunIntoSuite(suite);

  // Spin up a second user, invite them as viewer of the same org.
  const inviteeEmail = `suite-viewer+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: inviteeEmail,
      password: "testpass123",
      name: "ViewerAttempt",
      org_name: `ViewerOwn-${Date.now()}`,
    }),
  });
  const inviteeOwnToken = ((await reg.json()) as { token: string }).token;

  // Look up the owner's org id from /auth/me, invite, accept.
  const me = await fetch(`${BASE}/auth/me`, { headers: auth() });
  const meBody = (await me.json()) as { user: { orgId: number } };
  const ownerOrgId = meBody.user.orgId;

  const inv = await fetch(`${BASE}/orgs/${ownerOrgId}/invites`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
  });
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;
  const accept = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST", headers: { Authorization: `Bearer ${inviteeOwnToken}` },
  });
  const viewerToken = ((await accept.json()) as { token: string }).token;
  const viewerAuth = { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` };

  // Viewer CAN read.
  const read = await fetch(`${BASE}/suites`, { headers: viewerAuth });
  assert.equal(read.status, 200, "viewer must be able to read /suites");

  // Every mutation endpoint must 403.
  const rename = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/rename`, {
    method: "PATCH", headers: viewerAuth,
    body: JSON.stringify({ new_name: "viewer-renamed" }),
  });
  assert.equal(rename.status, 403, "viewer must NOT be able to rename a suite");

  const archive = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/archive`, {
    method: "PATCH", headers: viewerAuth,
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archive.status, 403, "viewer must NOT be able to archive a suite");

  const tpl = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}/rerun-template`, {
    method: "PATCH", headers: viewerAuth,
    body: JSON.stringify({ template: "viewer attempt" }),
  });
  assert.equal(tpl.status, 403, "viewer must NOT be able to set a rerun template");

  const del = await fetch(`${BASE}/suites/${encodeURIComponent(suite)}`, {
    method: "DELETE", headers: viewerAuth,
  });
  assert.equal(del.status, 403, "viewer must NOT be able to delete a suite — owner-only");
});
