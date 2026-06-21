/**
 * Error-group triage smoke tests — protects PATCH /errors/:fingerprint
 * (target_date / priority) and the target_date / priority fields on GET /errors.
 *
 * Phase 15.1 (remainder). The route mirrors the assign route's shape:
 * org-scoped, viewer-gated, lazy upsert of the error_groups row. The
 * security-relevant assertion is the viewer 403; the correctness ones are that
 * a valid PATCH round-trips through GET /errors, an invalid priority is
 * rejected (never reaches the DB CHECK as a 500), and an audit row is written.
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

const PORT = 3978;
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
      JWT_SECRET: "errors-triage-secret",
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
  const email = `errtriage+${label}+${stamp}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `ErrTriage-${label}`,
      org_name: `ErrTriageOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

/** Invite a fresh user as a viewer of `owner`'s org and accept. */
async function inviteViewer(owner: UserCtx): Promise<UserCtx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `errtriage+viewer+${stamp}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "ErrTriageViewer",
      org_name: `ErrTriageViewerOwn-${stamp}`,
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

interface TriageRow {
  fingerprint: string;
  target_date: string | null;
  priority: string | null;
  // GET /errors derives a default priority at read time when none is set
  // manually (Phase 15.2); `priority_source` distinguishes the two, so an
  // *unset* manual priority surfaces as a non-null derived value with
  // source 'derived' rather than null.
  priority_source: "manual" | "derived";
}

async function getError(token: string, suite: string, fp: string): Promise<TriageRow> {
  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as TriageRow[];
  const row = rows.find((r) => r.fingerprint === fp);
  assert.ok(row, "error group should still be present");
  return row;
}

async function patchTriage(token: string, fp: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/errors/${fp}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── happy path: a valid PATCH round-trips through GET /errors ──────────────

test("a valid PATCH sets priority + target_date, reflected in GET /errors", async () => {
  const owner = await registerOwner("happy");
  const suite = `errtriage-happy-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageHappyErr");

  // The group has no persisted error_groups row yet — PATCH must upsert it.
  const res = await patchTriage(owner.token, fp, { priority: "high", target_date: "2026-07-15" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: boolean; priority: string | null; target_date: string | null };
  assert.equal(body.updated, true);
  assert.equal(body.priority, "high");

  const row = await getError(owner.token, suite, fp);
  assert.equal(row.priority, "high", "priority reflects in GET /errors");
  // target_date comes back as a date — assert the YYYY-MM-DD prefix matches.
  assert.ok(row.target_date && String(row.target_date).startsWith("2026-07-15"), "target_date reflects in GET /errors");
});

// ── partial PATCH doesn't clobber the untouched field ─────────────────────

test("PATCHing only priority leaves an existing target_date intact, and null clears", async () => {
  const owner = await registerOwner("partial");
  const suite = `errtriage-partial-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriagePartialErr");

  await patchTriage(owner.token, fp, { target_date: "2026-08-01" });
  await patchTriage(owner.token, fp, { priority: "low" });
  let row = await getError(owner.token, suite, fp);
  assert.ok(row.target_date && String(row.target_date).startsWith("2026-08-01"), "target_date survived a priority-only PATCH");
  assert.equal(row.priority, "low");

  // null clears the *manual* priority without touching the other field. Post
  // Phase 15.2, GET then surfaces a derived priority (source 'derived'), so the
  // clear is observable via priority_source flipping back off 'manual'.
  await patchTriage(owner.token, fp, { priority: null });
  row = await getError(owner.token, suite, fp);
  assert.equal(row.priority_source, "derived", "clearing the manual priority hands the chip back to derivation");
  assert.ok(row.target_date && String(row.target_date).startsWith("2026-08-01"), "target_date untouched by the clear");
});

// ── validation: bad priority / bad date are 400, not 500 ──────────────────

test("an invalid priority is rejected with 400", async () => {
  const owner = await registerOwner("badprio");
  const suite = `errtriage-badprio-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageBadPrioErr");

  const res = await patchTriage(owner.token, fp, { priority: "urgent" });
  assert.equal(res.status, 400, "out-of-enum priority must be rejected");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /priority/i);

  // Nothing persisted — no manual priority was ever set, so GET reports the
  // read-time derived value (source 'derived'), never a stored 'urgent'.
  const row = await getError(owner.token, suite, fp);
  assert.equal(row.priority_source, "derived");
  assert.notEqual(row.priority, "urgent");
});

test("a malformed target_date is rejected with 400", async () => {
  const owner = await registerOwner("baddate");
  const suite = `errtriage-baddate-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageBadDateErr");

  const res = await patchTriage(owner.token, fp, { target_date: "not-a-date" });
  assert.equal(res.status, 400, "malformed date must be rejected before the DB");
});

test("PATCH with neither field is a 400 (nothing to do)", async () => {
  const owner = await registerOwner("empty");
  const suite = `errtriage-empty-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageEmptyErr");

  const res = await patchTriage(owner.token, fp, {});
  assert.equal(res.status, 400);
});

// ── viewers can't mutate triage metadata ──────────────────────────────────

test("a viewer is rejected with 403", async () => {
  const owner = await registerOwner("rolegate");
  const viewer = await inviteViewer(owner);
  const suite = `errtriage-viewer-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageViewerErr");

  const res = await patchTriage(viewer.token, fp, { priority: "high" });
  assert.equal(res.status, 403, "viewer role may not update triage metadata");
});

// ── an audit row is written for a successful update ───────────────────────

test("a successful PATCH writes an error.triage_update audit row", async () => {
  const owner = await registerOwner("audit");
  const suite = `errtriage-audit-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "TriageAuditErr");

  await patchTriage(owner.token, fp, { priority: "critical", target_date: "2026-09-01" });

  const res = await fetch(`${BASE}/audit?action=error.triage_update`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.ok(res.ok, `GET /audit failed: ${res.status}`);
  const entries = (await res.json()) as { action: string; target_id: string }[];
  const hit = entries.find((e) => e.action === "error.triage_update" && e.target_id === fp);
  assert.ok(hit, "an error.triage_update audit row should exist for this fingerprint");
});
