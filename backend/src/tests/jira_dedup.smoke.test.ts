/**
 * Jira issue-creation dedup under concurrency.
 *
 * createIssueForFingerprint must create AT MOST ONE Jira ticket per
 * (org, fingerprint), even when two callers race for a fingerprint that
 * isn't tracked yet — e.g. parallel CI shards both running
 * autoCreateIssuesForRun, or a user's manual "create issue" racing the
 * auto-create pass. The earlier check-then-create pattern let both callers
 * pass the existence check and each POST a ticket, recording only one and
 * orphaning the other. A per-(org, fingerprint) advisory lock + re-check
 * closes that window; these tests pin it.
 *
 * DB-backed (needs `pnpm db:up`): drives the real module against Postgres
 * with a local mock standing in for Jira Cloud, so the dedup is exercised
 * end-to-end (fast-path SELECT → lock → re-check → INSERT) rather than mocked.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createIssueForFingerprint } from "../integrations/jira.js";
import { encryptSecret, _resetKeyCache } from "../crypto.js";

// A real key is required: migration 045 constrains the token column to v1:
// ciphertext, so a plaintext fixture would be rejected. Set before any
// encrypt/decrypt runs and reset the lazy key cache so it's picked up. encrypt
// (seed) and decrypt (getJiraConfig) run in this same process, so it round-trips.
process.env.FLAKEY_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow — deterministic test fixture
_resetKeyCache();

const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const USER = process.env.DB_USER ?? "flakey_app";
const PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";
const DB = process.env.DB_NAME ?? "flakey";

let pool: pg.Pool;
let orgId: number;
let mock: http.Server;
let mockUrl: string;
let createCount = 0;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });

  // Mock Jira Cloud: count create calls and stall briefly so two concurrent
  // callers genuinely overlap inside the function (widening the race window the
  // old code lost on). Returns a distinct key per call, so a second create
  // would be observable both as a count of 2 AND as a divergent issue key.
  mock = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rest/api/2/issue") {
      createCount++;
      const n = createCount;
      setTimeout(() => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: `PROJ-${n}` }));
      }, 150);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  // Seed an org with Jira configured to point at the mock. Written straight to
  // the DB so we sidestep PATCH /jira/settings' SSRF gate (which blocks the
  // localhost mock). `organizations` has no RLS. The token goes through
  // encryptSecret so getJiraConfig's decryptSecret round-trips it whether or
  // not FLAKEY_ENCRYPTION_KEY is set in this test process.
  const slug = `jira-dedup-${Date.now()}`;
  const ins = await pool.query(
    `INSERT INTO organizations (name, slug, jira_base_url, jira_email, jira_api_token, jira_project_key, jira_issue_type, jira_auto_create)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    ["Jira Dedup Org", slug, mockUrl, "ci@test.local", encryptSecret("faketoken"), "PROJ", "Bug", true]
  );
  orgId = ins.rows[0].id;
});

after(async () => {
  if (pool) {
    if (orgId) {
      // failure_jira_issues is FORCE-RLS — delete inside an org context.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
        await client.query("DELETE FROM failure_jira_issues WHERE org_id = $1", [orgId]);
        await client.query("COMMIT");
      } catch { await client.query("ROLLBACK").catch(() => {}); }
      finally { client.release(); }
      await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
    }
    await pool.end();
  }
  if (mock) await new Promise<void>((resolve) => mock.close(() => resolve()));
});

async function countRows(fingerprint: string): Promise<number> {
  const client = await pool.connect();
  try {
    // failure_jira_issues is FORCE-RLS: the org context must live in a
    // transaction (a LOCAL set_config outside one is discarded before the
    // next statement, leaving the policy's ::int cast to choke on '').
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    const r = await client.query(
      "SELECT COUNT(*)::int AS n FROM failure_jira_issues WHERE org_id = $1 AND fingerprint = $2",
      [orgId, fingerprint]
    );
    await client.query("COMMIT");
    return r.rows[0].n;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

test("two concurrent calls for the same fingerprint create exactly ONE Jira ticket", async () => {
  createCount = 0;
  const fp = "jira-concurrent-fp";

  const [a, b] = await Promise.all([
    createIssueForFingerprint(orgId, null, fp, "Failure A", "desc A"),
    createIssueForFingerprint(orgId, null, fp, "Failure B", "desc B"),
  ]);

  // Exactly one ticket was POSTed to Jira — the race window is closed.
  assert.equal(createCount, 1, "only one Jira create should reach the API");
  // Both callers return the SAME recorded issue (no orphaned ticket). Don't pin
  // the literal key — the mock's numbering is its own business; the invariant is
  // that both callers converge on one ticket.
  assert.ok(a && b, "both calls return a result");
  assert.equal(a!.key, b!.key, "both callers see the same issue key");
  // Exactly one row recorded.
  assert.equal(await countRows(fp), 1, "exactly one failure_jira_issues row");
});

test("an already-tracked fingerprint returns the existing issue without a new create", async () => {
  createCount = 0;
  const fp = "jira-existing-fp";

  const first = await createIssueForFingerprint(orgId, null, fp, "First", "d");
  assert.equal(createCount, 1, "first call creates the ticket");
  assert.ok(first, "first call returns a result");

  const second = await createIssueForFingerprint(orgId, null, fp, "Second", "d");
  assert.equal(createCount, 1, "second call must NOT create a new ticket");
  assert.equal(second!.key, first!.key, "returns the originally-recorded key");
  assert.equal(await countRows(fp), 1, "still exactly one row");
});

test("distinct fingerprints each get their own ticket (no over-serialization)", async () => {
  createCount = 0;

  const [a, b] = await Promise.all([
    createIssueForFingerprint(orgId, null, "jira-distinct-1", "A", "d"),
    createIssueForFingerprint(orgId, null, "jira-distinct-2", "B", "d"),
  ]);

  assert.equal(createCount, 2, "two distinct fingerprints → two creates");
  assert.notEqual(a!.key, b!.key, "distinct fingerprints get distinct tickets");
  assert.equal(await countRows("jira-distinct-1"), 1);
  assert.equal(await countRows("jira-distinct-2"), 1);
});
