/**
 * Error-group assignee smoke tests — protects POST /errors/:fingerprint/assign
 * and the assigned_to / assigned_to_email fields on GET /errors.
 *
 * Assignment is lightweight failure-triage ownership ("who's chasing this"),
 * surfaced on the errors page and within a release's failure list. The
 * security-critical assertion here is the cross-org guard: `users` has no RLS
 * and GET /errors joins it to return assigned_to_email, so the assign route
 * MUST reject a user_id that isn't a member of the caller's org — otherwise an
 * admin could write any id and read back a foreign user's email (IDOR). This
 * mirrors the guard on the release session-result assign route.
 *
 * Each test registers its OWN org and uploads its OWN run, so assertions never
 * depend on seed data or other parallel agents sharing this DB.
 *
 * Route under test: src/routes/errors.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3977;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry until healthy */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "errors-assign-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

interface UserCtx {
  email: string;
  token: string;
  orgId: number;
  userId: number;
}

/** Register a brand-new org; the registrant is its owner. */
async function registerOwner(label: string): Promise<UserCtx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `errassign+${label}+${stamp}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `ErrAssign-${label}`,
      org_name: `ErrAssignOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

/** Invite a fresh user as a viewer of `owner`'s org and accept — returns the
 * viewer's org-scoped token. Mirrors security_hardening.smoke.test.ts. */
async function inviteViewer(owner: UserCtx): Promise<UserCtx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `errassign+viewer+${stamp}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "ErrAssignViewer",
      org_name: `ErrAssignViewerOwn-${stamp}`,
    }),
  });
  if (!reg.ok) throw new Error(`viewer register failed: ${reg.status}`);
  const regData = (await reg.json()) as { token: string; user: { id: number } };

  const inv = await fetch(`${BASE}/orgs/${owner.orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ email, role: "viewer" }),
  });
  if (!inv.ok) throw new Error(`invite create failed: ${inv.status}`);
  const inviteToken = ((await inv.json()) as { invite_token: string }).invite_token;

  const accept = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regData.token}` },
  });
  if (!accept.ok) throw new Error(`accept failed: ${accept.status}`);
  const acceptData = (await accept.json()) as { token: string };
  return { email, token: acceptData.token, orgId: owner.orgId, userId: regData.user.id };
}

/** Upload one failing run; returns the fingerprint of its single error group. */
async function uploadFailingRun(token: string, suite: string, message: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: suite, branch: "main", commit_sha: stamp,
      ci_run_id: `ci-${suite}-${stamp}`,
      started_at: "2026-04-10T00:00:00Z", finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 100 },
    specs: [{
      file_path: `${suite}.cy.ts`, title: suite,
      stats: { total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 100 },
      tests: [{
        title: "case 0", full_title: `${suite} > case 0`, status: "failed",
        duration_ms: 10, screenshot_paths: [],
        error: { message, stack: `${message}\n    at line 1` },
      }],
    }],
  }));
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);

  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as { fingerprint: string }[];
  assert.equal(rows.length, 1, "uploaded run should produce exactly one error group");
  return rows[0].fingerprint;
}

interface ErrorRow {
  fingerprint: string;
  assigned_to: number | null;
  assigned_to_email: string | null;
}

async function getError(token: string, suite: string, fp: string): Promise<ErrorRow> {
  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as ErrorRow[];
  const row = rows.find((r) => r.fingerprint === fp);
  assert.ok(row, "error group should still be present");
  return row;
}

async function assign(token: string, fp: string, userId: number | null): Promise<Response> {
  return fetch(`${BASE}/errors/${fp}/assign`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
}

// ── happy path: assign reflects in GET /errors, then un-assign clears it ──

test("assigning an org member is reflected in GET /errors, and null un-assigns", async () => {
  const owner = await registerOwner("happy");
  const suite = `errassign-happy-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "AssignHappyErr");

  // The group has no persisted error_groups row yet — assign must upsert it.
  const res = await assign(owner.token, fp, owner.userId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { assigned: boolean; user_id: number | null };
  assert.equal(body.assigned, true);
  assert.equal(body.user_id, owner.userId);

  const assigned = await getError(owner.token, suite, fp);
  assert.equal(assigned.assigned_to, owner.userId, "assigned_to reflects the chosen user");
  assert.equal(assigned.assigned_to_email, owner.email, "assigned_to_email is joined from users");

  const unassign = await assign(owner.token, fp, null);
  assert.equal(unassign.status, 200);
  const cleared = await getError(owner.token, suite, fp);
  assert.equal(cleared.assigned_to, null, "passing null un-assigns");
  assert.equal(cleared.assigned_to_email, null, "no email once un-assigned");
});

// ── the security guard: cross-org user_id is rejected (IDOR) ──────────────

test("a user from another org cannot be assigned (cross-org IDOR guard)", async () => {
  const owner = await registerOwner("orgA");
  const stranger = await registerOwner("orgB");
  const suite = `errassign-idor-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "AssignIdorErr");

  const res = await assign(owner.token, fp, stranger.userId);
  assert.equal(res.status, 400, "assigning a non-member must be rejected");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not a member/i);

  // And nothing leaked: the group stays unassigned, no foreign email exposed.
  const after = await getError(owner.token, suite, fp);
  assert.equal(after.assigned_to, null);
  assert.equal(after.assigned_to_email, null);
});

// ── viewers can't assign ──────────────────────────────────────────────────

test("a viewer is rejected with 403", async () => {
  const owner = await registerOwner("rolegate");
  const viewer = await inviteViewer(owner);
  const suite = `errassign-viewer-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "AssignViewerErr");

  const res = await assign(viewer.token, fp, viewer.userId);
  assert.equal(res.status, 403, "viewer role may not assign");
});
