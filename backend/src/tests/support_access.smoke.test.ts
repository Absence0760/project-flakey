/**
 * Cross-org support access (finding F2).
 *
 * A platform support user (users.is_support, set out-of-band) can mint a
 * short-lived, READ-ONLY "view as org" token for one org, audited in that
 * org's trail. This spec proves the trust boundary:
 *   1. Only a support user can mint a token; a normal owner gets 403.
 *   2. Minting writes a support.session.start row in the TARGET org's audit.
 *   3. The token can GET an allow-listed read surface scoped to the target org
 *      (and only the target org's data — RLS).
 *   4. The token cannot write (any non-GET → 403) and cannot reach a
 *      non-allow-listed resource (e.g. /jira → 403), so it can't read secrets
 *      or escalate.
 *   5. Revoking is_support invalidates a live support token on its next request.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const PORT = 3959;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let dbAdmin: pg.Client;
let supportToken: string; // org-A user's normal session, after is_support=true
let normalToken: string;  // org-A user before/without is_support — a plain owner
let actorEmail: string;
let actorId: number;
let orgBId: number;
let orgBToken: string;    // target org's own admin token (independent audit read)
let orgBRunId: number;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

async function register(label: string): Promise<{ token: string; id: number; orgId: number; email: string }> {
  const email = `support+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: `Support-${label}`, org_name: `SupportOrg-${label}-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`register ${label}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string; user: { id: number; orgId: number } };
  return { token: data.token, id: data.user.id, orgId: data.user.orgId, email };
}

async function uploadRun(token: string, suite: string): Promise<number> {
  const fd = new FormData();
  fd.set("payload", JSON.stringify({
    meta: { suite_name: suite, branch: "main", commit_sha: "x", ci_run_id: `ci-${suite}`, started_at: "2026-05-12T00:00:00Z", finished_at: "2026-05-12T00:00:10Z", reporter: "mochawesome" },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [{ file_path: `${suite}.cy.ts`, title: suite, stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 10 }, tests: [{ title: "t", full_title: "t", status: "passed", duration_ms: 10, error: null, screenshot_paths: [] }] }],
  }));
  const res = await fetch(`${BASE}/runs/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env, PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app", DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey", JWT_SECRET: "support-access-test-secret",
      ALLOW_REGISTRATION: "true", NODE_ENV: "test", FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const actor = await register("actor");
  normalToken = actor.token; supportToken = actor.token; actorEmail = actor.email; actorId = actor.id;
  const target = await register("target");
  orgBId = target.orgId; orgBToken = target.token;
  // Give org B a run so the support session has something org-scoped to read.
  orgBRunId = await uploadRun(target.token, `support-target-${Date.now().toString(36)}`);

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey", password: "flakey", database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) { server.kill("SIGTERM"); await once(server, "exit").catch(() => {}); }
});

function authGet(token: string, path: string) {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

test("a non-support user cannot mint a support token (403)", async () => {
  const res = await fetch(`${BASE}/support/orgs/${orgBId}/token`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${normalToken}` },
    body: JSON.stringify({ reason: "ticket #1" }),
  });
  assert.equal(res.status, 403);
});

test("a support user mints a read-only token, audited in the target org", async () => {
  // Promote the actor out-of-band (no API grants is_support).
  await dbAdmin.query("UPDATE users SET is_support = true WHERE id = $1", [actorId]);

  const mint = await fetch(`${BASE}/support/orgs/${orgBId}/token`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${supportToken}` },
    body: JSON.stringify({ reason: "ticket-4242 wrong count" }),
  });
  const mintText = await mint.text();
  assert.equal(mint.status, 201, `mint failed: ${mintText}`);
  const minted = JSON.parse(mintText) as { token: string; orgId: number; mode: string };
  assert.equal(minted.orgId, orgBId);
  assert.equal(minted.mode, "read-only");

  // GET org B's runs with the support token — scoped to B, includes B's run.
  const runs = await authGet(minted.token, "/runs");
  assert.equal(runs.status, 200);
  const body = (await runs.json()) as { runs: Array<{ id: number }> };
  assert.ok(body.runs.some((r) => r.id === orgBRunId), "support session must see the target org's run");

  // The mint wrote a support.session.start row into org B's audit. Verify it
  // via org B's OWN admin token (independent of the support session) so this
  // assertion can't false-pass on an error body if /audit were ever removed
  // from the support allow-list.
  const audit = await authGet(orgBToken, "/audit?action=support.session.start");
  assert.equal(audit.status, 200);
  const rows = (await audit.json()) as Array<{ action: string; user_email: string; detail: { reason?: string } }>;
  assert.ok(rows.length >= 1, "support.session.start must be in the target org's audit");
  assert.equal(rows[0].user_email, actorEmail, "audit attributes the access to the support actor");
  assert.equal(rows[0].detail?.reason, "ticket-4242 wrong count");

  // The support row must be appended into the hash chain (not a raw NULL-hash
  // INSERT): org B already has hashed rows from its run upload, so an unchained
  // support row would make /audit/verify report the org as tampered.
  const verify = await authGet(orgBToken, "/audit/verify");
  assert.equal(verify.status, 200);
  const v = (await verify.json()) as { ok: boolean; reason: string | null };
  assert.equal(v.ok, true, `target org chain must verify after a support session: ${v.reason}`);

  // And the support session itself can read the (allow-listed) audit log.
  assert.equal((await authGet(minted.token, "/audit")).status, 200);

  // Read-only: a write is refused.
  const write = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ fullTitle: "x", filePath: "y", suiteName: "z", reason: "nope" }),
  });
  assert.equal(write.status, 403, "support sessions must be read-only");

  // Not on the allow-list (integration secrets surface): refused even for GET.
  const jira = await authGet(minted.token, "/jira/settings");
  assert.equal(jira.status, 403, "support sessions must not reach the integration/secrets surface");
});

test("revoking is_support invalidates a live support token on its next request", async () => {
  // Re-grant in case a prior test left it revoked — keep this test order-independent.
  await dbAdmin.query("UPDATE users SET is_support = true WHERE id = $1", [actorId]);
  const mint = await fetch(`${BASE}/support/orgs/${orgBId}/token`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${supportToken}` },
    body: JSON.stringify({ reason: "ticket revoke test" }),
  });
  assert.equal(mint.status, 201);
  const token = ((await mint.json()) as { token: string }).token;

  // Works while support is active.
  assert.equal((await authGet(token, "/runs")).status, 200);

  // Revoke the platform support flag.
  await dbAdmin.query("UPDATE users SET is_support = false WHERE id = $1", [actorId]);

  // The (still-unexpired) token must now be rejected.
  assert.equal((await authGet(token, "/runs")).status, 401, "revoking is_support must kill live support sessions");
});
