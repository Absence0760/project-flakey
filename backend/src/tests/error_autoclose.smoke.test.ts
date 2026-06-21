/**
 * Phase 15.2 (b) auto-close-on-green smoke.
 *
 * The nightly retention pass (runRetentionCleanup) gained a per-org sweep: for
 * an org that opted into triage_autoclose_days, every open/investigating/
 * regressed error group whose fingerprint has gone quiet for the window flips to
 * `fixed`, with an audit row + an error.autoclosed webhook. Default OFF: a NULL
 * setting skips the org.
 *
 * This drives the sweep in-process (it has no HTTP surface, mirroring
 * audit_filters_retention.smoke.test.ts), backdating the run so the group's
 * derived last_seen is stale, and asserts:
 *   1. an opted-in org's stale open group → fixed + audit `error.autoclosed`
 *      + an error.autoclosed webhook POST.
 *   2. a fresh group (last_seen inside the window) is NOT closed.
 *   3. an org with triage_autoclose_days unset (default OFF) is never swept.
 *
 * Each test registers its OWN org/suite so it coexists with parallel agents.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http, { type Server } from "node:http";
import pg from "pg";
import { runRetentionCleanup } from "../retention.js";

const PORT = 3958;
const RECEIVER_PORT = 3908;
const BASE = `http://localhost:${PORT}`;
const RECEIVER_URL = `http://localhost:${RECEIVER_PORT}/hook`;

let server: ChildProcess;
let receiver: Server;
let dbAdmin: pg.Client;

type Received = { event: string; body: Record<string, unknown> };
let received: Received[] = [];
function resetReceived(): void { received = []; }

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

async function waitFor(predicate: () => boolean, maxMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const event = typeof parsed.event === "string" ? parsed.event : "unknown";
        received.push({ event, body: parsed });
      } catch {
        received.push({ event: "invalid-json", body: { raw: body } });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(RECEIVER_PORT, resolve));

  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "error-autoclose-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
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
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

interface Ctx { token: string; orgId: number; userId: number; }

async function registerOwner(label: string): Promise<Ctx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `errac+${label}+${stamp}@test.local`,
      password: "testpass123",
      name: `ErrAC-${label}`,
      org_name: `ErrACOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

async function setAutocloseDays(ctx: Ctx, days: number | null): Promise<void> {
  const res = await fetch(`${BASE}/orgs/${ctx.orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ triage_autoclose_days: days }),
  });
  if (!res.ok) throw new Error(`set autoclose failed: ${res.status} ${await res.text().catch(() => "")}`);
}

/** Disable run-retention for this org so backdating a run to age its error
 *  group does NOT trip the retention prune (orgs default to retention_days=7).
 *  The autoclose sweep operates on the run-derived last_seen, so the runs must
 *  survive — null retention keeps them. Done by direct SQL (the settings route
 *  rejects 0/negatives; null is the documented "disable" value but the route
 *  only sets it via the same path — keep the test deterministic with SQL). */
async function disableRetention(orgId: number): Promise<void> {
  await dbAdmin.query(`UPDATE organizations SET retention_days = NULL WHERE id = $1`, [orgId]);
}

async function configureWebhook(token: string, events: string[]): Promise<number> {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "ac-receiver", url: RECEIVER_URL, events, platform: "generic" }),
  });
  if (!res.ok) throw new Error(`POST /webhooks failed: ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

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
  const rows = (await res.json()) as Array<{ fingerprint: string }>;
  assert.equal(rows.length, 1, "uploaded run should produce exactly one error group");
  return rows[0].fingerprint;
}

async function getStatus(token: string, suite: string, fp: string): Promise<string> {
  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as Array<{ fingerprint: string; status: string }>;
  const row = rows.find((r) => r.fingerprint === fp);
  assert.ok(row, "error group should still be present");
  return row.status;
}

/** Persist an error_groups row + backdate the run so the group's derived
 *  last_seen is `daysAgo` days old. Returns nothing; status set via API. */
async function backdateRun(suite: string, daysAgo: number): Promise<void> {
  await dbAdmin.query(
    `UPDATE runs SET created_at = NOW() - ($1 * INTERVAL '1 day') WHERE suite_name = $2`,
    [daysAgo, suite]
  );
}

// ── 1. opted-in org: stale open group auto-closes with audit + webhook ───────

test("an opted-in org's stale open group auto-closes on the sweep, with audit + error.autoclosed webhook", async () => {
  resetReceived();
  const owner = await registerOwner("close");
  const webhookId = await configureWebhook(owner.token, ["error.autoclosed"]);
  try {
    const suite = `errac-close-${Date.now()}`;
    const fp = await uploadFailingRun(owner.token, suite, "AutoCloseErr");
    assert.equal(await getStatus(owner.token, suite, fp), "open");

    // Persist the group (an upload alone leaves it lazy/open with no row).
    // PATCH status to its current 'open' creates the error_groups row so the
    // sweep's UPDATE has something to flip. (A lazy group already auto-closes
    // logically via COALESCE 'open', but the sweep operates on persisted rows.)
    await fetch(`${BASE}/errors/${fp}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ status: "open" }),
    });

    // Opt in (3-day window) and age the run past it (10 days quiet). Disable
    // run-retention so the backdated run survives for the sweep to read.
    await setAutocloseDays(owner, 3);
    await disableRetention(owner.orgId);
    await backdateRun(suite, 10);

    await runRetentionCleanup();

    // Group is now fixed.
    assert.equal(await getStatus(owner.token, suite, fp), "fixed",
      "a stale open group in an opted-in org must auto-close to fixed");

    // Audit row landed (system actor → no user).
    const auditRes = await fetch(`${BASE}/audit?action=error.autoclosed&limit=1000`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const auditRows = (await auditRes.json()) as Array<{ action: string; target_id: string; user_email: string | null; detail: { previous_status?: string } | null }>;
    const row = auditRows.find((r) => r.target_id === fp);
    assert.ok(row, "an error.autoclosed audit row must be written for the closed group");
    assert.equal(row!.user_email, null, "auto-close is system-initiated (no acting user)");
    assert.equal(row!.detail?.previous_status, "open", "audit detail records the prior status");

    // Webhook dispatched.
    await waitFor(() => received.some((r) => r.event === "error.autoclosed"));
    const events = received.filter((r) => r.event === "error.autoclosed");
    assert.equal(events.length, 1, "exactly one error.autoclosed POST must arrive");
    const body = events[0].body as { error_group?: { fingerprint?: string; status?: string } };
    assert.equal(body.error_group?.fingerprint, fp);
    assert.equal(body.error_group?.status, "fixed");
  } finally {
    await fetch(`${BASE}/webhooks/${webhookId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` },
    }).catch(() => {});
  }
});

// ── 2. a fresh group (inside the window) is NOT closed ───────────────────────

test("a group whose last_seen is INSIDE the window is not auto-closed", async () => {
  const owner = await registerOwner("fresh");
  const suite = `errac-fresh-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "FreshErr");
  await fetch(`${BASE}/errors/${fp}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ status: "open" }),
  });

  // 30-day window, run only 2 days old → still inside the window → keep.
  await setAutocloseDays(owner, 30);
  await disableRetention(owner.orgId);
  await backdateRun(suite, 2);

  await runRetentionCleanup();

  assert.equal(await getStatus(owner.token, suite, fp), "open",
    "a group seen recently (inside the window) must stay open");
});

// ── 3. default OFF: an org with the setting unset is never swept ──────────────

test("an org with triage_autoclose_days unset (default OFF) is never auto-closed even when stale", async () => {
  const owner = await registerOwner("off");
  const suite = `errac-off-${Date.now()}`;
  const fp = await uploadFailingRun(owner.token, suite, "OffErr");
  await fetch(`${BASE}/errors/${fp}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ status: "open" }),
  });

  // Do NOT set triage_autoclose_days (stays NULL = OFF). Age the run hard.
  await disableRetention(owner.orgId);
  await backdateRun(suite, 90);

  await runRetentionCleanup();

  assert.equal(await getStatus(owner.token, suite, fp), "open",
    "with autoclose unset, even a 90-day-stale group must stay open (default OFF)");
});
