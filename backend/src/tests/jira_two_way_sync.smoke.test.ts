/**
 * Phase 15.4 — two-way Jira sync, both directions, with a MOCKED Jira.
 *
 * No live Jira: a local http.Server stands in for Jira Cloud and records every
 * inbound call (transitions / comments), exactly like jira_dedup.smoke.test.ts.
 * There is intentionally NO live-Jira e2e — Jira Cloud is an external SaaS with
 * no local stub, so the contract is pinned at the client boundary here and the
 * HMAC math in jira_webhook_hmac.unit.test.ts. (Stated, not silently skipped.)
 *
 * OUTBOUND: a manual PATCH /errors/:fp/status → fixed drives the linked issue
 *   through the resolve transition + comments, and writes a
 *   jira.issue.transition audit row.
 * INBOUND (flag ON): a correctly-signed issue-closed payload flips the linked
 *   error group to `fixed`; an UNSIGNED / bad-signature payload is rejected
 *   401 (fail closed) and does NOT change status.
 * INBOUND (flag OFF): POST /jira/webhook returns 404 (kill switch).
 *
 * DB-backed (needs a migrated flakey Postgres; point DB_PORT at it). Spawns the
 * real backend twice — once with FLAKEY_JIRA_WEBHOOK_ENABLED=true, once without
 * — because the flag is read at module load.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { encryptSecret, _resetKeyCache } from "../crypto.js";
import { syncErrorGroupTransition } from "../integrations/jira.js";

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow — deterministic test fixture
process.env.FLAKEY_ENCRYPTION_KEY = ENC_KEY;
_resetKeyCache();

const HOST = process.env.DB_HOST ?? "localhost";
const DB_PORT = Number(process.env.DB_PORT ?? 5432);
const DB_USER = process.env.DB_USER ?? "flakey_app";
const DB_PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";
const DB = process.env.DB_NAME ?? "flakey";

const PORT_ON = 3994; // FLAKEY_JIRA_WEBHOOK_ENABLED=true
const PORT_OFF = 3995; // flag unset → off
const BASE_ON = `http://localhost:${PORT_ON}`;
const BASE_OFF = `http://localhost:${PORT_OFF}`;
const WEBHOOK_SECRET = "test-webhook-secret";

let pool: pg.Pool;
let orgId: number;
let token: string;
let serverOn: ChildProcess;
let serverOff: ChildProcess;
let mock: http.Server;
let mockUrl: string;

// Observed outbound Jira calls.
let transitionCalls: Array<{ issue: string; transitionId: string }> = [];
let commentCalls: Array<{ issue: string; body: string }> = [];
// When true, the mock answers every Jira call with HTTP 500 — exercises the
// best-effort/resilience contract (a Jira outage must not break the DB path).
let failJira = false;

const FINGERPRINT = "jira-2way-fp";
const ISSUE_KEY = "SYNC-1";

function commonEnv(port: number, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PORT: String(port),
    DB_HOST: HOST,
    DB_PORT: String(DB_PORT),
    DB_USER,
    DB_PASSWORD,
    DB_NAME: DB,
    JWT_SECRET: "jira-2way-secret",
    FLAKEY_ENCRYPTION_KEY: ENC_KEY,
    ALLOW_REGISTRATION: "true",
    NODE_ENV: "test",
    ...extra,
  };
}

async function waitForHealth(base: string, maxMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Backend at ${base} did not become healthy`);
}

before(async () => {
  pool = new pg.Pool({ host: HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB });

  // Mock Jira Cloud: record transition + comment calls; report the issue as
  // transitionable to a "Done" transition (id "31").
  mock = http.createServer((req, res) => {
    const url = req.url ?? "";
    // Resilience switch: when armed, every Jira API call 500s. The high-level
    // sync swallows + logs, so the DB transition must still commit unaffected.
    if (failJira) {
      // Drain the body so the socket closes cleanly, then 500.
      req.on("data", () => {});
      req.on("end", () => { res.writeHead(500); res.end("jira down"); });
      return;
    }
    if (req.method === "GET" && /\/transitions$/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ transitions: [{ id: "31", name: "Done" }, { id: "11", name: "To Do" }] }));
      return;
    }
    if (req.method === "POST" && /\/transitions$/.test(url)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = /\/issue\/([^/]+)\/transitions$/.exec(url);
        const parsed = JSON.parse(body || "{}");
        transitionCalls.push({ issue: m?.[1] ?? "?", transitionId: parsed.transition?.id });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "POST" && /\/comment$/.test(url)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = /\/issue\/([^/]+)\/comment$/.exec(url);
        const parsed = JSON.parse(body || "{}");
        commentCalls.push({ issue: m?.[1] ?? "?", body: parsed.body });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "10000" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  // Seed an org with Jira pointed at the mock + a webhook secret + a link.
  // Written straight to the DB to sidestep the SSRF gate on PATCH /jira/settings
  // (which would block the localhost mock URL).
  const slug = `jira-2way-${Date.now()}`;
  const ins = await pool.query(
    `INSERT INTO organizations
       (name, slug, jira_base_url, jira_email, jira_api_token, jira_project_key,
        jira_issue_type, jira_auto_create, jira_webhook_secret,
        jira_resolve_transition, jira_reopen_transition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      "Jira 2way Org", slug, mockUrl, "ci@test.local", encryptSecret("faketoken"),
      "SYNC", "Bug", false, encryptSecret(WEBHOOK_SECRET), "Done", "To Do",
    ]
  );
  orgId = ins.rows[0].id;

  // Link the fingerprint to the Jira issue (FORCE-RLS → write in an org ctx).
  {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
      await client.query(
        `INSERT INTO failure_jira_issues (org_id, fingerprint, issue_key, issue_url, created_by)
         VALUES ($1,$2,$3,$4,NULL)`,
        [orgId, FINGERPRINT, ISSUE_KEY, `${mockUrl}/browse/${ISSUE_KEY}`]
      );
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
  }

  // A user in THIS org so PATCH /errors hits the right tenant. Register creates
  // a new org, so instead attach the registered user to our seeded org.
  serverOn = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: commonEnv(PORT_ON, { FLAKEY_JIRA_WEBHOOK_ENABLED: "true" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverOn.stderr?.on("data", (d) => process.stderr.write(d));
  serverOff = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: commonEnv(PORT_OFF), // flag unset → webhook disabled
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverOff.stderr?.on("data", (d) => process.stderr.write(d));
  await Promise.all([waitForHealth(BASE_ON), waitForHealth(BASE_OFF)]);

  // Register a user, then move their membership + token's org to our seeded org
  // so the authenticated PATCH operates on the linked fingerprint's org.
  const email = `jira2way+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE_ON}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "J2", org_name: `Throwaway-${Date.now()}` }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const userId = (await reg.json() as { user: { id: number } }).user.id;

  // Re-point the user's (only) membership at the seeded org as admin, then mint
  // a fresh token by logging in — resolveOrg picks the earliest-joined
  // membership, which is now the seeded org.
  await pool.query(
    `UPDATE org_members SET org_id = $1, role = 'admin' WHERE user_id = $2`,
    [orgId, userId]
  );
  const login = await fetch(`${BASE_ON}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123" }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  token = (await login.json() as { token: string }).token;
});

after(async () => {
  for (const s of [serverOn, serverOff]) {
    if (s && !s.killed) { s.kill("SIGTERM"); await once(s, "exit").catch(() => {}); }
  }
  if (mock) await new Promise<void>((r) => mock.close(() => r()));
  if (pool) {
    if (orgId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
        await client.query("DELETE FROM failure_jira_issues WHERE org_id = $1", [orgId]);
        await client.query("DELETE FROM error_groups WHERE org_id = $1", [orgId]);
        await client.query("COMMIT");
      } catch { await client.query("ROLLBACK").catch(() => {}); }
      finally { client.release(); }
      await pool.query("DELETE FROM org_members WHERE org_id = $1", [orgId]);
      await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
    }
    await pool.end();
  }
});

async function readStatus(): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    const r = await client.query(
      "SELECT status FROM error_groups WHERE org_id = $1 AND fingerprint = $2",
      [orgId, FINGERPRINT]
    );
    await client.query("COMMIT");
    return r.rows[0]?.status ?? null;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

async function auditExists(action: string, targetId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    const r = await client.query(
      `SELECT 1 FROM audit_log WHERE org_id = $1 AND action = $2 AND target_id = $3 LIMIT 1`,
      [orgId, action, targetId]
    );
    await client.query("COMMIT");
    return r.rows.length > 0;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    const r = await client.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = $2 AND target_id = $3`,
      [orgId, action, targetId]
    );
    await client.query("COMMIT");
    return r.rows[0].n as number;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

function sign(raw: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(raw)).digest("hex");
}

// ── OUTBOUND ──────────────────────────────────────────────────────────────

test("manual → fixed transitions the linked Jira issue + comments + audits", async () => {
  transitionCalls = [];
  commentCalls = [];

  const res = await fetch(`${BASE_ON}/errors/${FINGERPRINT}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: "fixed" }),
  });
  assert.equal(res.status, 200, "status update succeeds");

  // The outbound sync is fire-and-forget (after the response). Poll briefly for
  // the mock to observe the transition + comment.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (transitionCalls.length === 0 || commentCalls.length === 0)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(transitionCalls.length, 1, "exactly one transition POSTed to Jira");
  assert.equal(transitionCalls[0].issue, ISSUE_KEY);
  assert.equal(transitionCalls[0].transitionId, "31", "drove the 'Done' transition id");
  assert.equal(commentCalls.length, 1, "exactly one comment POSTed");
  assert.match(commentCalls[0].body, /^Flakey:/, "comment is Flakey-prefixed");

  // Audited jira.issue.transition. audit_log is FORCE-RLS, so the read must
  // run inside the org context (same as readStatus).
  const deadlineA = Date.now() + 5000;
  let audited = false;
  while (Date.now() < deadlineA && !audited) {
    audited = await auditExists("jira.issue.transition", FINGERPRINT);
    if (!audited) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(audited, "jira.issue.transition audit row written");
});

// ── INBOUND (flag ON) ───────────────────────────────────────────────────────

test("inbound: a correctly-signed issue-closed flips status to fixed", async () => {
  // Reset status away from fixed so the flip is observable.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    await client.query(
      `UPDATE error_groups SET status = 'regressed' WHERE org_id = $1 AND fingerprint = $2`,
      [orgId, FINGERPRINT]
    );
    await client.query("COMMIT");
  } finally { client.release(); }

  const raw = JSON.stringify({
    issue: { key: ISSUE_KEY, fields: { status: { statusCategory: { key: "done" } } } },
  });
  const res = await fetch(`${BASE_ON}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": sign(raw) },
    body: raw,
  });
  assert.equal(res.status, 200, "signed issue-closed accepted");
  assert.equal(await readStatus(), "fixed", "linked error group flipped to fixed");
});

test("inbound: an UNSIGNED payload is rejected 401 (fail closed) and does not change status", async () => {
  // Put status into a known non-fixed state.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    await client.query(
      `UPDATE error_groups SET status = 'open' WHERE org_id = $1 AND fingerprint = $2`,
      [orgId, FINGERPRINT]
    );
    await client.query("COMMIT");
  } finally { client.release(); }

  const raw = JSON.stringify({
    issue: { key: ISSUE_KEY, fields: { status: { statusCategory: { key: "done" } } } },
  });
  const res = await fetch(`${BASE_ON}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }, // no signature
    body: raw,
  });
  assert.equal(res.status, 401, "unsigned payload rejected");
  assert.equal(await readStatus(), "open", "status unchanged by a rejected request");
});

test("inbound: a BAD signature is rejected 401 (fail closed)", async () => {
  const raw = JSON.stringify({
    issue: { key: ISSUE_KEY, fields: { status: { statusCategory: { key: "done" } } } },
  });
  const res = await fetch(`${BASE_ON}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": "sha256=deadbeef" },
    body: raw,
  });
  assert.equal(res.status, 401, "bad signature rejected");
  assert.equal(await readStatus(), "open", "status unchanged");
});

// ── INBOUND (flag OFF) ───────────────────────────────────────────────────────

test("inbound: the route 404s when FLAKEY_JIRA_WEBHOOK_ENABLED is off", async () => {
  const raw = JSON.stringify({
    issue: { key: ISSUE_KEY, fields: { status: { statusCategory: { key: "done" } } } },
  });
  const res = await fetch(`${BASE_OFF}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": sign(raw) },
    body: raw,
  });
  assert.equal(res.status, 404, "kill switch: disabled instance returns 404 even for a valid signature");
});

// ── OUTBOUND resilience: a Jira outage must not break the DB transition ───────

test("manual → fixed still commits the DB transition when every Jira call 500s (best-effort)", async () => {
  // Put the group into a known non-fixed state first.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    await client.query(
      `UPDATE error_groups SET status = 'open' WHERE org_id = $1 AND fingerprint = $2`,
      [orgId, FINGERPRINT]
    );
    await client.query("COMMIT");
  } finally { client.release(); }

  // Snapshot the transition-audit count so we can prove no NEW one is written
  // while Jira is down (the audit fires only on a real reflection).
  const auditsBefore = await auditCount("jira.issue.transition", FINGERPRINT);

  failJira = true;
  try {
    const res = await fetch(`${BASE_ON}/errors/${FINGERPRINT}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "fixed" }),
    });
    // The status change MUST succeed even though Jira is down — the Jira
    // reflection is best-effort and runs after the response.
    assert.equal(res.status, 200, "the status change succeeds despite Jira being down");
  } finally {
    // Give the fire-and-forget sync a beat to fail+swallow before re-arming Jira.
    await new Promise((r) => setTimeout(r, 500));
    failJira = false;
  }

  // The DB transition is durable.
  assert.equal(await readStatus(), "fixed", "the error group is fixed in the DB regardless of Jira");

  // No NEW jira.issue.transition audit is written when Jira never moved (the
  // sync returned null) — the audit fires ONLY on a real reflection.
  const auditsAfter = await auditCount("jira.issue.transition", FINGERPRINT);
  assert.equal(auditsAfter, auditsBefore, "no jira.issue.transition audit when Jira was unreachable");
});

// ── OUTBOUND: → regressed drives the REOPEN transition (the Jira-can't-do-it path) ──
//
// The reopen-on-regression is fired from ingest (syncRegressionsToJira), which
// is fire-and-forget after an upload commit and awkward to drive end-to-end.
// syncErrorGroupTransition is the shared exported primitive both the manual
// →fixed and the ingest →regressed paths call, so we exercise the regressed
// branch directly: it must drive the REOPEN transition id ("To Do" → "11"),
// distinct from the resolve id ("Done" → "31") the →fixed path uses, and return
// the linked issue key (so the caller audits).
test("outbound: → regressed drives the configured reopen transition (id 11), not the resolve one", async () => {
  transitionCalls = [];
  commentCalls = [];

  const issueKey = await syncErrorGroupTransition(
    orgId,
    FINGERPRINT,
    "regressed",
    "this test regressed — reopening.",
  );

  assert.equal(issueKey, ISSUE_KEY, "returns the linked issue key on a successful reflection");
  assert.equal(transitionCalls.length, 1, "exactly one transition POSTed");
  assert.equal(transitionCalls[0].issue, ISSUE_KEY);
  assert.equal(transitionCalls[0].transitionId, "11", "drove the 'To Do' (reopen) transition id, not 'Done'");
  assert.equal(commentCalls.length, 1, "left a comment");
  assert.match(commentCalls[0].body, /^Flakey:/);
});

test("outbound: syncErrorGroupTransition swallows a Jira outage and returns null (no throw)", async () => {
  failJira = true;
  try {
    const issueKey = await syncErrorGroupTransition(
      orgId, FINGERPRINT, "fixed", "test marked fixed.",
    );
    assert.equal(issueKey, null, "a Jira outage yields null (best-effort), never a throw");
  } finally {
    failJira = false;
  }
});

// ── INBOUND: audit row + unlinked-issue 204 (org resolved from the LINK) ──────

test("inbound: a verified issue-closed writes a jira.webhook.issue_closed audit row", async () => {
  // Reset away from fixed so the close is a real flip.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    await client.query(
      `UPDATE error_groups SET status = 'regressed' WHERE org_id = $1 AND fingerprint = $2`,
      [orgId, FINGERPRINT]
    );
    await client.query("COMMIT");
  } finally { client.release(); }

  const raw = JSON.stringify({
    issue: { key: ISSUE_KEY, fields: { status: { statusCategory: { key: "done" } } } },
  });
  const res = await fetch(`${BASE_ON}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": sign(raw) },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal(await readStatus(), "fixed");
  // The inbound flip is audited under the resolved org (system actor).
  assert.ok(
    await auditExists("jira.webhook.issue_closed", FINGERPRINT),
    "jira.webhook.issue_closed audit row written for the inbound flip"
  );
});

test("inbound: a signed event for an UNLINKED issue is a benign 204 (no link, no leak, no cross-tenant)", async () => {
  // An issue key that no failure_jira_issues row maps to. The org is resolved
  // SERVER-SIDE from the link, never from the payload — with no link the request
  // can't name (or cross into) any org. lookup returns nothing ⇒ 204.
  const raw = JSON.stringify({
    issue: { key: "UNKNOWN-9999", fields: { status: { statusCategory: { key: "done" } } } },
  });
  // Even with a syntactically-valid signature under OUR secret, the absence of a
  // link means no org/secret is resolved at all — it short-circuits to 204
  // before any verification, leaking nothing about org existence.
  const res = await fetch(`${BASE_ON}/jira/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": sign(raw) },
    body: raw,
  });
  assert.equal(res.status, 204, "an unlinked issue is a benign 204");

  // Our linked group's status is untouched by the unlinked event.
  assert.equal(await readStatus(), "fixed", "an unlinked event must not touch another org's group");
});
