/**
 * Smoke tests for POST /support/orgs/:orgId/token (src/routes/support.ts).
 *
 * This is the ONLY deliberately cross-tenant endpoint in the API: a platform
 * support user mints a short-lived, read-only "view as org" JWT scoped to one
 * org so a ticket can be triaged without joining the customer's org. Because it
 * crosses the tenant boundary, every clause of its contract is a security
 * invariant — this file pins all of them.
 *
 * The cross-tenant guarantee:
 *   - Only a user with users.is_support = true may mint. is_support is set
 *     out-of-band by an operator (no API grants it), so a normal session — even
 *     the OWNER of another org — gets 403 "Support role required". There is no
 *     standing cross-org path for an ordinary user.
 *   - A support-read ("view as") session cannot mint a *further* token (403):
 *     no privilege chaining off an already-clamped session.
 *
 * Input contract: reason is required (400 when missing/blank), an invalid org
 * id → 400, an unknown org → 404, success → 201 with the documented body.
 *
 * Accountability: issuance writes a 'support.session.start' row into the TARGET
 * org's audit_log BEFORE the token is returned (asserted by reading the target
 * org's trail with a superuser client, scoped to that org, attributed to the
 * support actor) — the route does this via an awaited tenantQuery so a failed
 * audit write aborts issuance.
 *
 * Read-only clamp: the minted token is exercised against real routes. requireAuth
 * (not the route handlers) is the authoritative write gate for a support session:
 *   - GET on an allow-listed read surface (/runs) → 200 (reads the target org).
 *   - any non-GET, even on an allow-listed base (POST /notes) → 403 read-only.
 *   - GET on a non-allow-listed surface (/orgs) → 403 not-available.
 *   - the support session cannot re-mint (POST /support) → 403.
 *
 * Each test creates its own users + orgs with unique names so it's parallel-safe
 * and doesn't pollute the additive seed. Needs the local DB (db.js defaults to
 * flakey_app/flakey); spawns its own backend on a dedicated port.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import pg from "pg";

const PORT = 3951;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
// Superuser client (bypasses RLS) used to flip users.is_support — there is no
// API to grant it — and to read the target org's audit trail for assertions.
let dbAdmin: pg.Client;

// The support actor: a platform support user (is_support flipped in setup).
let supportToken: string;
let supportUserId: number;
let supportEmail: string;

// The target org being "viewed" — owned by a *different*, ordinary user.
let targetOrgId: number;

// An ordinary owner of yet another org, used to prove that being an org OWNER
// confers no cross-tenant minting power.
let outsiderToken: string;

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

async function register(label: string): Promise<{ token: string; userId: number; orgId: number }> {
  const email = `${label}+${Date.now()}-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: label,
      org_name: `${label}Org-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  if (!res.ok) throw new Error(`register(${label}) failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number; email: string } };
  return { token: data.token, userId: data.user.id, orgId: data.user.orgId };
}

function mint(token: string, orgId: number | string, body: unknown) {
  return fetch(`${BASE}/support/orgs/${orgId}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "support-token-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
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

  // The support actor — an ordinary user until we flip the platform flag.
  const support = await register("support");
  supportToken = support.token;
  supportUserId = support.userId;

  // The target org: owned by a *different* user the support actor is NOT a
  // member of — so any read it does is genuinely cross-tenant.
  const target = await register("target");
  targetOrgId = target.orgId;

  // A third, unrelated user who OWNS their own org — used to prove ownership of
  // *some* org grants no minting power over *another*.
  const outsider = await register("outsider");
  outsiderToken = outsider.token;

  // Capture the support actor's email so we can assert the audit row's actor.
  const who = await dbAdmin.query("SELECT email FROM users WHERE id = $1", [supportUserId]);
  supportEmail = who.rows[0].email;

  // Grant the platform support flag out-of-band (no API does this).
  await dbAdmin.query("UPDATE users SET is_support = true WHERE id = $1", [supportUserId]);
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Authorization: who may mint ────────────────────────────────────────────

test("a normal session — even an org OWNER of another org — cannot mint (403 Support role required)", async () => {
  // The outsider is an owner of their own org. Ownership of one org must not
  // open a cross-tenant path into another. This is the core guarantee.
  const res = await mint(outsiderToken, targetOrgId, { reason: "should be denied" });
  assert.equal(res.status, 403);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Support role required");
});

test("a support user (is_support=true) can mint a read-only token (201 with the documented body)", async () => {
  const res = await mint(supportToken, targetOrgId, { reason: "triage ticket #4242" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    token: string;
    orgId: number;
    mode: string;
    expiresInSeconds: number;
  };
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0, "a token must be returned");
  assert.equal(body.orgId, targetOrgId);
  assert.equal(body.mode, "read-only");
  assert.equal(body.expiresInSeconds, 1800);
});

// ── Input contract ─────────────────────────────────────────────────────────

test("reason is required: missing reason → 400", async () => {
  const res = await mint(supportToken, targetOrgId, {});
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "A reason is required for support access");
});

test("reason is required: blank/whitespace reason → 400", async () => {
  const res = await mint(supportToken, targetOrgId, { reason: "   " });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "A reason is required for support access");
});

test("an invalid (non-numeric) org id → 400", async () => {
  const res = await mint(supportToken, "not-a-number", { reason: "x" });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Invalid org id");
});

test("an unknown (valid-but-nonexistent) org id → 404", async () => {
  // Within int4 range, far past any seeded/registered org, so the org lookup
  // misses (the validation gate passes, so we reach the existence check).
  const res = await mint(supportToken, 2_000_000_000, { reason: "x" });
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Org not found");
});

// ── Accountability: the audit row is written into the TARGET org ────────────

test("issuance writes a 'support.session.start' row into the TARGET org's audit_log, attributed to the actor", async () => {
  const reason = `audit-proof-${crypto.randomUUID()}`;
  const res = await mint(supportToken, targetOrgId, { reason });
  assert.equal(res.status, 201);

  // Read the audit trail with a superuser client so we can scope the WHERE to
  // the target org explicitly (rather than rely on a session var) and prove the
  // row landed in THAT org's trail, attributed to the support actor, with the
  // reason we passed. The route writes this BEFORE returning the token, so by
  // the time we have a 201 the row must already exist.
  const rows = await dbAdmin.query(
    `SELECT user_id, target_type, target_id, detail
       FROM audit_log
      WHERE org_id = $1 AND action = 'support.session.start' AND detail->>'reason' = $2`,
    [targetOrgId, reason]
  );
  assert.equal(rows.rows.length, 1, "exactly one matching support.session.start row in the target org's trail");
  const row = rows.rows[0];
  assert.equal(row.user_id, supportUserId, "the row is attributed to the support actor");
  assert.equal(row.target_type, "org");
  assert.equal(row.target_id, String(targetOrgId), "the audited target is the org being viewed");
  assert.equal(row.detail.actor_email, supportEmail, "the actor's email is recorded for the customer-visible trail");

  // The audit row must NOT have leaked into a different org's trail.
  const elsewhere = await dbAdmin.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE org_id <> $1 AND action = 'support.session.start' AND detail->>'reason' = $2`,
    [targetOrgId, reason]
  );
  assert.equal(elsewhere.rows[0].n, 0, "the support-access row must be scoped to the target org only");
});

// ── Read-only clamp: what the minted token can and cannot do ────────────────

test("the minted token can READ the target org on an allow-listed surface (GET /runs → 200)", async () => {
  const mintRes = await mint(supportToken, targetOrgId, { reason: "exercise read clamp" });
  assert.equal(mintRes.status, 201);
  const { token: supportSession } = (await mintRes.json()) as { token: string };

  // GET on an allow-listed base, read-only → permitted. The handler scopes the
  // query to req.user.orgId (= targetOrgId) via tenantQuery, so this is a real
  // cross-tenant read of the target org under RLS.
  const res = await fetch(`${BASE}/runs`, {
    headers: { Authorization: `Bearer ${supportSession}` },
  });
  assert.equal(res.status, 200, "an allow-listed GET must be served for a support session");
  const body = (await res.json()) as { runs: unknown[] };
  assert.ok(Array.isArray(body.runs), "GET /runs returns the target org's runs list");
});

test("the minted token CANNOT write, even on an allow-listed base (POST /notes → 403 read-only)", async () => {
  const mintRes = await mint(supportToken, targetOrgId, { reason: "exercise write clamp" });
  assert.equal(mintRes.status, 201);
  const { token: supportSession } = (await mintRes.json()) as { token: string };

  // /notes IS on the support read allow-list, but the method is POST. The
  // GET/HEAD-only clamp in requireAuth (the authoritative write gate) must
  // refuse it regardless of the route's own orgRole-based guards.
  const res = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${supportSession}` },
    body: JSON.stringify({ fingerprint: "deadbeef", note: "should never persist" }),
  });
  assert.equal(res.status, 403);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Support sessions are read-only");
});

test("the minted token CANNOT reach a non-allow-listed surface (GET /orgs → 403 not available)", async () => {
  const mintRes = await mint(supportToken, targetOrgId, { reason: "exercise surface clamp" });
  assert.equal(mintRes.status, 201);
  const { token: supportSession } = (await mintRes.json()) as { token: string };

  // /orgs is deliberately NOT on SUPPORT_READ_BASEURLS (it exposes org config),
  // so even a read is refused for a support session.
  const res = await fetch(`${BASE}/orgs`, {
    headers: { Authorization: `Bearer ${supportSession}` },
  });
  assert.equal(res.status, 403);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "This resource is not available in a support session");
});

test("a support-read session cannot mint a further token (POST /support → 403)", async () => {
  const mintRes = await mint(supportToken, targetOrgId, { reason: "no privilege chaining" });
  assert.equal(mintRes.status, 201);
  const { token: supportSession } = (await mintRes.json()) as { token: string };

  // /support is not on the read allow-list AND this is a POST, so requireAuth's
  // clamp refuses it before the handler. The handler's own isSupportRead guard
  // is belt-and-suspenders behind that. Either way: no chaining.
  const res = await mint(supportSession, targetOrgId, { reason: "trying to chain" });
  assert.equal(res.status, 403, "a support session must not be able to mint another support token");
});
