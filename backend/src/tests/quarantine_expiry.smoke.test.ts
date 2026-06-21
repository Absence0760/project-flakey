/**
 * Phase 15.3 quarantine-expiry smoke.
 *
 * The nightly retention pass (runRetentionCleanup) gained an expired-quarantine
 * sweep: a quarantined_tests row whose expires_at is in the past is removed and a
 * `quarantine.expired` audit row is written (system actor, no user). This drives
 * the sweep in-process (it has no HTTP surface, mirroring
 * error_autoclose.smoke.test.ts) and asserts:
 *
 *   1. fingerprint link round-trips: POST /quarantine with a future expires_at +
 *      error_fingerprint surfaces both on GET /quarantine.
 *   2. expiry-on-sweep: backdate expires_at to the past → the sweep removes the
 *      row and writes a `quarantine.expired` audit row carrying the fingerprint.
 *   3. a quarantine with NO expiry (and one whose expiry is still in the future)
 *      survives the sweep — we only lift past-due rows.
 *
 * The route rejects a past expires_at (must be future), so the test sets a future
 * expiry via the API then backdates it via direct SQL — the only way to get a
 * genuinely-expired row the way prod would (clock advancing past it).
 *
 * Each test registers its OWN org/suite so it coexists with parallel agents.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import { runRetentionCleanup } from "../retention.js";

const PORT = 3961;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;

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

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "quarantine-expiry-secret",
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
});

interface Ctx { token: string; orgId: number; userId: number; }

async function registerOwner(label: string): Promise<Ctx> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `qexp+${label}+${stamp}@test.local`,
      password: "testpass123",
      name: `QExp-${label}`,
      org_name: `QExpOrg-${label}-${stamp}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { token: data.token, orgId: data.user.orgId, userId: data.user.id };
}

interface QRow {
  id: number; full_title: string; suite_name: string;
  expires_at: string | null; error_fingerprint: string | null;
}

async function listQuarantines(token: string, suite: string): Promise<QRow[]> {
  const res = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /quarantine failed: ${res.status}`);
  return (await res.json()) as QRow[];
}

async function addQuarantine(
  token: string,
  body: { fullTitle: string; suiteName: string; filePath?: string; reason?: string; expires_at?: string; error_fingerprint?: string }
): Promise<Response> {
  return fetch(`${BASE}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// A valid md5-hex fingerprint to link.
const FP = "0123456789abcdef0123456789abcdef";

// ── 1. fingerprint link + future expiry round-trip on GET ────────────────────

test("POST /quarantine accepts a future expires_at + error_fingerprint and both round-trip on GET", async () => {
  const owner = await registerOwner("roundtrip");
  const suite = `qexp-roundtrip-${Date.now()}`;
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const res = await addQuarantine(owner.token, {
    fullTitle: `${suite} > case 0`, suiteName: suite, filePath: `${suite}.cy.ts`,
    reason: "flaky", expires_at: future, error_fingerprint: FP,
  });
  assert.equal(res.status, 201, await res.text().catch(() => ""));

  const rows = await listQuarantines(owner.token, suite);
  assert.equal(rows.length, 1, "the quarantine should be listed");
  assert.ok(rows[0].expires_at, "expires_at round-trips");
  assert.equal(Date.parse(rows[0].expires_at!), Date.parse(future), "expires_at matches what was set");
  assert.equal(rows[0].error_fingerprint, FP, "error_fingerprint round-trips");
});

test("POST /quarantine rejects a past expires_at and a malformed fingerprint", async () => {
  const owner = await registerOwner("validate");
  const suite = `qexp-validate-${Date.now()}`;
  const past = new Date(Date.now() - 1000).toISOString();

  const r1 = await addQuarantine(owner.token, { fullTitle: `${suite} > a`, suiteName: suite, expires_at: past });
  assert.equal(r1.status, 400, "a past expires_at must 400");

  const r2 = await addQuarantine(owner.token, { fullTitle: `${suite} > b`, suiteName: suite, error_fingerprint: "not-md5" });
  assert.equal(r2.status, 400, "a non-md5 fingerprint must 400");
});

// ── 2. expiry-on-sweep removes the row + writes quarantine.expired audit ──────

test("the retention sweep removes an expired quarantine and writes a quarantine.expired audit row with the fingerprint", async () => {
  const owner = await registerOwner("sweep");
  const suite = `qexp-sweep-${Date.now()}`;
  const fullTitle = `${suite} > case 0`;
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Add with a FUTURE expiry (the route requires it) + a fingerprint link.
  const res = await addQuarantine(owner.token, {
    fullTitle, suiteName: suite, filePath: `${suite}.cy.ts`, reason: "flaky",
    expires_at: future, error_fingerprint: FP,
  });
  assert.equal(res.status, 201);

  // Backdate expires_at into the past — the only way to get a genuinely-expired
  // row (the route won't accept a past timestamp directly). Mirrors how prod
  // reaches this state when the clock advances past the future expiry.
  await dbAdmin.query(
    `UPDATE quarantined_tests SET expires_at = NOW() - INTERVAL '1 day'
       WHERE org_id = $1 AND full_title = $2 AND suite_name = $3`,
    [owner.orgId, fullTitle, suite]
  );

  await runRetentionCleanup();

  // The row is gone.
  const rows = await listQuarantines(owner.token, suite);
  assert.equal(rows.length, 0, "the expired quarantine must be removed by the sweep");

  // A quarantine.expired audit row landed, system actor, carrying the fingerprint.
  const auditRes = await fetch(`${BASE}/audit?action=quarantine.expired&limit=1000`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  const auditRows = (await auditRes.json()) as Array<{
    action: string; target_id: string; user_email: string | null;
    detail: { suite_name?: string; error_fingerprint?: string } | null;
  }>;
  const row = auditRows.find((r) => r.target_id === fullTitle);
  assert.ok(row, "a quarantine.expired audit row must be written for the lifted test");
  assert.equal(row!.user_email, null, "expiry is system-initiated (no acting user)");
  assert.equal(row!.detail?.suite_name, suite, "audit detail records the suite");
  assert.equal(row!.detail?.error_fingerprint, FP, "audit detail records the linked fingerprint");
});

// ── 3. non-expired quarantines survive the sweep ─────────────────────────────

test("a quarantine with no expiry and one with a future expiry both survive the sweep", async () => {
  const owner = await registerOwner("survive");
  const suite = `qexp-survive-${Date.now()}`;
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // (a) No expiry → indefinite mute, must never be swept.
  const noExpiry = await addQuarantine(owner.token, { fullTitle: `${suite} > indefinite`, suiteName: suite });
  assert.equal(noExpiry.status, 201);

  // (b) Future expiry → not yet due, must survive.
  const futureExpiry = await addQuarantine(owner.token, { fullTitle: `${suite} > future`, suiteName: suite, expires_at: future });
  assert.equal(futureExpiry.status, 201);

  await runRetentionCleanup();

  const rows = await listQuarantines(owner.token, suite);
  assert.equal(rows.length, 2, "neither a no-expiry nor a future-expiry quarantine may be swept");
});
