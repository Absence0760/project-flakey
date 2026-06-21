/**
 * Phase 15.2 (a) recurrence → auto-reopen smoke.
 *
 * The single highest-signal triage event is a failure we'd declared `fixed`
 * coming back. This file proves the ingest-time hook end-to-end against the
 * real upload route + DB:
 *
 *   1. Upload a failing run → the error group exists (status defaults to open).
 *   2. Mark it `fixed` (PATCH /errors/:fp/status).
 *   3. Upload the SAME fingerprint again → the group auto-transitions to
 *      `regressed`, recurrence_count bumps to 1, last_recurred_at is stamped,
 *      and an `error.regressed` webhook POST is dispatched.
 *   4. A still-`fixed`-with-no-recurrence guard: re-uploading does NOT re-bump
 *      once it's already `regressed` (only the fixed→regressed edge counts).
 *
 * Each test registers its OWN org + suite so it coexists with parallel agents
 * on the shared dev DB. Mirrors errors_assign.smoke.test.ts (org/run setup) and
 * webhook_e2e.smoke.test.ts (in-process receiver + dispatch assertion).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http, { type Server } from "node:http";

const PORT = 3979;
const RECEIVER_PORT = 3909;
const BASE = `http://localhost:${PORT}`;
const RECEIVER_URL = `http://localhost:${RECEIVER_PORT}/hook`;

let server: ChildProcess;
let receiver: Server;

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
      JWT_SECRET: "error-recurrence-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
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
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

interface Ctx { token: string; orgId: number; userId: number; }

async function registerOwner(label: string): Promise<Ctx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `errrecur+${label}+${stamp}@test.local`,
      password: "testpass123",
      name: `ErrRecur-${label}`,
      org_name: `ErrRecurOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

async function configureWebhook(token: string, events: string[]): Promise<number> {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "recur-receiver", url: RECEIVER_URL, events, platform: "generic" }),
  });
  if (!res.ok) throw new Error(`POST /webhooks failed: ${res.status} ${await res.text().catch(() => "")}`);
  return ((await res.json()) as { id: number }).id;
}

/** Upload one failing run for `suite` with a stable error message → returns the
 *  fingerprint of the produced error group. */
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

interface ErrRow { fingerprint: string; status: string; recurrence_count: number; }

async function getError(token: string, suite: string, fp: string): Promise<ErrRow> {
  const res = await fetch(`${BASE}/errors?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = (await res.json()) as ErrRow[];
  const row = rows.find((r) => r.fingerprint === fp);
  assert.ok(row, "error group should still be present");
  return row;
}

async function setStatus(token: string, fp: string, status: string): Promise<void> {
  const res = await fetch(`${BASE}/errors/${fp}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`set status failed: ${res.status} ${await res.text().catch(() => "")}`);
}

// ── the core behaviour: fixed fingerprint reappears → regressed ──────────────

test("a fixed fingerprint reappearing on ingest auto-transitions to regressed, bumps recurrence_count, and fires error.regressed", async () => {
  resetReceived();
  const owner = await registerOwner("regress");
  const webhookId = await configureWebhook(owner.token, ["error.regressed"]);
  try {
    const suite = `errrecur-regress-${Date.now()}`;
    const msg = "RecurErr: the same failure";

    // 1. First failing upload — group is created (defaults to open).
    const fp = await uploadFailingRun(owner.token, suite, msg);
    const initial = await getError(owner.token, suite, fp);
    assert.equal(initial.status, "open", "a fresh group defaults to open");
    assert.equal(Number(initial.recurrence_count), 0, "recurrence_count starts at 0");

    // 2. A human marks it fixed.
    await setStatus(owner.token, fp, "fixed");
    assert.equal((await getError(owner.token, suite, fp)).status, "fixed");

    // 3. The same fingerprint fails again on a new upload → auto-reopen.
    await uploadFailingRun(owner.token, suite, msg);

    const regressed = await getError(owner.token, suite, fp);
    assert.equal(regressed.status, "regressed", "a fixed fingerprint reappearing must flip to regressed");
    assert.equal(Number(regressed.recurrence_count), 1, "recurrence_count must increment to 1");

    // 4. The error.regressed webhook must be dispatched.
    await waitFor(() => received.some((r) => r.event === "error.regressed"));
    const events = received.filter((r) => r.event === "error.regressed");
    assert.equal(events.length, 1, "exactly one error.regressed POST must arrive");
    const body = events[0].body as { event: string; error_group?: { fingerprint?: string; status?: string; suite_name?: string } };
    assert.equal(body.event, "error.regressed");
    assert.equal(body.error_group?.fingerprint, fp, "payload must identify the regressed fingerprint");
    assert.equal(body.error_group?.status, "regressed");
    assert.equal(body.error_group?.suite_name, suite);
  } finally {
    await fetch(`${BASE}/webhooks/${webhookId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` },
    }).catch(() => {});
  }
});

// ── only the fixed→regressed EDGE counts (no double-bump) ────────────────────

test("re-uploading an already-regressed fingerprint does NOT re-bump recurrence_count", async () => {
  const owner = await registerOwner("noredouble");
  const suite = `errrecur-edge-${Date.now()}`;
  const msg = "EdgeErr: only the fixed->regressed edge counts";

  const fp = await uploadFailingRun(owner.token, suite, msg);
  await setStatus(owner.token, fp, "fixed");

  // First recurrence: fixed → regressed, count → 1.
  await uploadFailingRun(owner.token, suite, msg);
  assert.equal(Number((await getError(owner.token, suite, fp)).recurrence_count), 1);

  // Second failing upload while already regressed: the WHERE status='fixed'
  // guard means nothing changes — count stays 1.
  await uploadFailingRun(owner.token, suite, msg);
  const after = await getError(owner.token, suite, fp);
  assert.equal(after.status, "regressed", "stays regressed");
  assert.equal(Number(after.recurrence_count), 1, "recurrence_count must NOT re-bump while already regressed");
});

// ── a never-fixed group is untouched by the recurrence hook ──────────────────

test("an open (never-fixed) fingerprint reappearing stays open with recurrence_count 0", async () => {
  const owner = await registerOwner("openstays");
  const suite = `errrecur-open-${Date.now()}`;
  const msg = "OpenStaysErr";

  const fp = await uploadFailingRun(owner.token, suite, msg);
  // Re-upload the same failing fingerprint without ever marking it fixed.
  await uploadFailingRun(owner.token, suite, msg);

  const row = await getError(owner.token, suite, fp);
  assert.equal(row.status, "open", "an open group is not touched by the recurrence hook");
  assert.equal(Number(row.recurrence_count), 0, "recurrence_count stays 0 for a never-fixed group");
});
