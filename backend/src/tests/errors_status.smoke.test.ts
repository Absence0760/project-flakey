/**
 * Error-group status smoke tests — protects PATCH /errors/:fingerprint/status.
 *
 * The security-relevant assertion is the viewer 403: changing a group's
 * workflow state is a privileged triage mutation (and a `→ fixed` transition
 * drives outbound Jira resolution), so it must be gated the same way the
 * sibling triage PATCH and assign POST are. This route predated that
 * convention and was, until the accompanying fix, fail-open — any authenticated
 * member, viewers included, could move status and resolve linked Jira issues.
 *
 * The correctness assertions are that an owner CAN set status (200, reflected in
 * GET /errors), an invalid status is rejected with 400 (never reaching the DB
 * CHECK as a 500), and a status change writes an error.status audit row.
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

const PORT = 3970;
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
      JWT_SECRET: "errors-status-secret",
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
  const email = `errstatus+${label}+${stamp}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `ErrStatus-${label}`,
      org_name: `ErrStatusOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

/** Invite a fresh user as a viewer of `owner`'s org and accept. */
async function inviteViewer(owner: UserCtx): Promise<UserCtx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `errstatus+viewer+${stamp}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "ErrStatusViewer",
      org_name: `ErrStatusViewerOwn-${stamp}`,
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

interface StatusRow {
  fingerprint: string;
  status: string;
}

async function getError(token: string, suite: string, fp: string): Promise<StatusRow> {
  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as StatusRow[];
  const row = rows.find((r) => r.fingerprint === fp);
  assert.ok(row, "error group should still be present");
  return row;
}

async function patchStatus(token: string, fp: string, status: unknown): Promise<Response> {
  return fetch(`${BASE}/errors/${fp}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

// ── happy path: an owner can set status, reflected in GET /errors ──────────

test("an owner can PATCH status, reflected in GET /errors", async () => {
  const owner = await registerOwner("happy");
  const suite = `errstatus-happy-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "StatusHappyErr");

  const res = await patchStatus(owner.token, fp, "investigating");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: boolean; status: string };
  assert.equal(body.updated, true);
  assert.equal(body.status, "investigating");

  const row = await getError(owner.token, suite, fp);
  assert.equal(row.status, "investigating", "status reflects in GET /errors");
});

// ── validation: an invalid status is a 400, not a 500 ─────────────────────

test("an invalid status is rejected with 400", async () => {
  const owner = await registerOwner("badstatus");
  const suite = `errstatus-bad-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "StatusBadErr");

  const res = await patchStatus(owner.token, fp, "totally-bogus");
  assert.equal(res.status, 400, "out-of-enum status must be rejected before the DB");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /status/i);

  // Nothing persisted — the group keeps its default 'open' status.
  const row = await getError(owner.token, suite, fp);
  assert.equal(row.status, "open");
});

// ── the security regression: viewers can't mutate status ──────────────────
//
// This is the load-bearing assertion. The status route predated the
// viewer-gating convention applied to the sibling triage/assign mutations and
// was fail-open — any member could move workflow state (and a `→ fixed`
// resolves the linked Jira issue). A viewer must be rejected with 403 and the
// status must remain unchanged.

test("a viewer is rejected with 403 and the status is unchanged", async () => {
  const owner = await registerOwner("rolegate");
  const viewer = await inviteViewer(owner);
  const suite = `errstatus-viewer-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "StatusViewerErr");

  const res = await patchStatus(viewer.token, fp, "fixed");
  assert.equal(res.status, 403, "viewer role may not change error-group status");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /admin role required/i);

  // The group is still 'open' (its default) — the viewer's PATCH never landed.
  const row = await getError(owner.token, suite, fp);
  assert.equal(row.status, "open", "the viewer's rejected PATCH left status untouched");
});

// ── an audit row is written for a successful status change ────────────────

test("a successful status PATCH writes an error.status audit row", async () => {
  const owner = await registerOwner("audit");
  const suite = `errstatus-audit-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "StatusAuditErr");

  await patchStatus(owner.token, fp, "known");

  const res = await fetch(`${BASE}/audit?action=error.status`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.ok(res.ok, `GET /audit failed: ${res.status}`);
  const entries = (await res.json()) as { action: string; target_id: string }[];
  const hit = entries.find((e) => e.action === "error.status" && e.target_id === fp);
  assert.ok(hit, "an error.status audit row should exist for this fingerprint");
});
