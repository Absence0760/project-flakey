/**
 * Audit-retrieval filtering + retention-cleanup auditing smoke.
 *
 * Covers two review findings:
 *
 *   F5 — GET /audit gained optional `action`, `start_date`, and `end_date`
 *        filters (all parameterized) on top of the existing limit/offset
 *        paging. This pins that an `action=` filter and a date-range filter
 *        each return the expected subset.
 *
 *   F7 — the daily retention cleanup deletes runs per org with no audit
 *        record, leaving a forensic gap. `runRetentionCleanup` now writes a
 *        'retention.cleanup' audit row (system actor → user_id NULL) for every
 *        org whose cleanup removed >0 runs. This drives the cleanup in-process
 *        and asserts the row is visible via GET /audit with the deleted_count +
 *        retention_days detail an investigator needs.
 *
 * Strategy mirrors audit_coverage.smoke.test.ts: act via the HTTP API, then
 * read back through an admin DB client / the API. Retention is invoked
 * in-process (the exported `runRetentionCleanup`) since it has no HTTP surface;
 * db.js defaults to the same flakey_app/flakey DB the spawned server uses.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import { runRetentionCleanup } from "../retention.js";

const PORT = 3960;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;

interface OwnerCtx {
  email: string;
  token: string;
  userId: number;
  orgId: number;
}

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

async function registerOwner(label: string): Promise<OwnerCtx> {
  const email = `audit-fr+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `AuditFR-${label}`,
      org_name: `AuditFROrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { email, token: data.token, userId: data.user.id, orgId: data.user.orgId };
}

async function uploadRun(token: string, suiteName: string): Promise<number> {
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: { suite_name: suiteName, branch: "main", commit_sha: "abc", ci_run_id: `ci-${Date.now()}-${Math.random()}`,
      started_at: "2026-04-10T00:00:00Z", finished_at: "2026-04-10T00:00:30Z", reporter: "mochawesome" },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 100 },
    specs: [{ file_path: "a.cy.ts", title: "a", stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 100 },
      tests: [{ title: "t", full_title: "a > t", status: "passed", duration_ms: 100, screenshot_paths: [] }] }],
  }));
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status}`);
  return ((await up.json()) as { id: number }).id;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "audit-fr-test-secret",
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

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── F5: GET /audit filters return the expected subset ──────────────────

test("GET /audit?action=<x> returns only rows with that action", async () => {
  const owner = await registerOwner("action-filter");

  // Generate two distinct audited actions in this org: an api-key create
  // ('auth.api_key.create') and a settings update ('settings.update').
  await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ label: `fr-key-${Date.now()}` }),
  });
  await fetch(`${BASE}/orgs/${owner.orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ retention_days: 30 }),
  });

  // Unfiltered: both actions present.
  const all = await fetch(`${BASE}/audit?limit=1000`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(all.status, 200);
  const allRows = (await all.json()) as { action: string }[];
  const actions = new Set(allRows.map((r) => r.action));
  assert.ok(actions.has("auth.api_key.create"), "unfiltered result should include the key-create action");
  assert.ok(actions.has("settings.update"), "unfiltered result should include the settings-update action");

  // Filtered by action: only that action comes back.
  const filtered = await fetch(`${BASE}/audit?action=settings.update`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(filtered.status, 200);
  const filteredRows = (await filtered.json()) as { action: string }[];
  assert.ok(filteredRows.length > 0, "action filter should return the matching rows");
  assert.ok(
    filteredRows.every((r) => r.action === "settings.update"),
    "every row in an action-filtered result must match the requested action",
  );
});

test("GET /audit?start_date=&end_date= bounds rows by created_at", async () => {
  const owner = await registerOwner("date-filter");

  // Create a fresh audited event whose timestamp we control.
  await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ label: `fr-datekey-${Date.now()}` }),
  });

  // Pin its created_at to a known ancient timestamp so the window math is
  // deterministic and immune to clock skew.
  const pinned = "2020-01-15T12:00:00Z";
  await dbAdmin.query(
    `UPDATE audit_log SET created_at = $1
     WHERE org_id = $2 AND action = 'auth.api_key.create'`,
    [pinned, owner.orgId],
  );

  // A window that contains the pinned row returns it…
  const inWindow = await fetch(
    `${BASE}/audit?start_date=2020-01-01T00:00:00Z&end_date=2020-02-01T00:00:00Z`,
    { headers: { Authorization: `Bearer ${owner.token}` } },
  );
  assert.equal(inWindow.status, 200);
  const inRows = (await inWindow.json()) as { action: string; created_at: string }[];
  assert.ok(
    inRows.some((r) => r.action === "auth.api_key.create"),
    "a date window containing the pinned row must return it",
  );
  // …and every returned row is genuinely inside the window.
  for (const r of inRows) {
    const t = new Date(r.created_at).getTime();
    assert.ok(
      t >= Date.parse("2020-01-01T00:00:00Z") && t <= Date.parse("2020-02-01T00:00:00Z"),
      "every row must fall within the requested [start_date, end_date]",
    );
  }

  // A window entirely after the pinned row excludes it.
  const afterWindow = await fetch(
    `${BASE}/audit?start_date=2021-01-01T00:00:00Z`,
    { headers: { Authorization: `Bearer ${owner.token}` } },
  );
  assert.equal(afterWindow.status, 200);
  const afterRows = (await afterWindow.json()) as { action: string; created_at: string }[];
  assert.ok(
    !afterRows.some((r) => r.created_at === new Date(pinned).toISOString()),
    "a start_date after the pinned row must exclude it",
  );
});

// ── F7: retention cleanup writes a 'retention.cleanup' audit row ────────

test("runRetentionCleanup writes a 'retention.cleanup' audit row for an org that deleted runs", async () => {
  const owner = await registerOwner("retention");

  // Upload a run, then set a short retention window and backdate the run so
  // it's eligible for deletion on the next cleanup pass.
  const runId = await uploadRun(owner.token, `fr-retention-${Date.now()}`);
  await fetch(`${BASE}/orgs/${owner.orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ retention_days: 1 }),
  });
  await dbAdmin.query(
    "UPDATE runs SET created_at = NOW() - INTERVAL '10 days' WHERE id = $1",
    [runId],
  );

  // Drive the daily cleanup in-process (no HTTP surface).
  await runRetentionCleanup();

  // The run is gone…
  const gone = await dbAdmin.query("SELECT id FROM runs WHERE id = $1", [runId]);
  assert.equal(gone.rows.length, 0, "the backdated run must have been deleted by retention cleanup");

  // …and a retention.cleanup audit row landed, visible via GET /audit.
  const res = await fetch(`${BASE}/audit?action=retention.cleanup&limit=1000`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as {
    action: string;
    target_type: string;
    user_name: string | null;
    user_email: string | null;
    detail: { deleted_count?: number; retention_days?: number } | null;
  }[];
  assert.ok(rows.length >= 1, "retention.cleanup audit row must be visible via GET /audit");
  const row = rows[0];
  assert.equal(row.action, "retention.cleanup");
  assert.equal(row.target_type, "run");
  // System actor → user_id NULL → no joined user.
  assert.equal(row.user_email, null, "retention cleanup has no acting user (system actor)");
  assert.ok(row.detail, "detail must be present");
  assert.ok(
    (row.detail!.deleted_count ?? 0) >= 1,
    "detail.deleted_count must record how many runs were removed",
  );
  assert.equal(row.detail!.retention_days, 1, "detail.retention_days must record the policy that triggered the delete");
});
