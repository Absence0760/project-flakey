/**
 * Smoke tests for POST /analyze/fix-pr (src/routes/analyze.ts) — the AI-generated
 * DRAFT fix-PR endpoint.
 *
 * SAFETY-CRITICAL endpoint: it writes to a customer's git repo. The gates that
 * keep it safe are what we assert here, in the order the route applies them:
 *
 *   - Selector validation: the body must carry EXACTLY one of testId /
 *     fingerprint (zero or both → 400). This runs before anything else.
 *   - Viewer block: generating a fix calls the model + writes the repo, so it's
 *     contributor+ only (viewer → 403).
 *   - Provider gate: no git provider configured → 409 (no PR can be opened).
 *   - AI gate: AI provider off → 503 (no patch can be generated).
 *
 * The AI provider is OFF in this env (no AI_PROVIDER / ANTHROPIC_API_KEY) and we
 * do NOT mock one — so the live happy path (generate → branch → commit → PR) and
 * the size/truncation guards, which require BOTH a reachable git provider AND a
 * configured model, are out of reach for a network-free smoke test. We assert
 * the gates instead. The provider gate is exercised by configuring a syntactically
 * valid git provider directly in the DB (superuser; `organizations` has no RLS):
 * with a provider present but AI off, the route reaches the AI gate (503) WITHOUT
 * making any network call, because getProviderForOrg() only reads the DB and
 * constructs the adapter — it never calls out until getDefaultBranch().
 *
 * Each test owns its org + data, so assertions are independent of seed data and
 * of parallel test agents.
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
let ownerToken: string;
let viewerToken: string;
let orgId: number;
let suiteName: string;
let failedTestId: number;
let fingerprint: string;
let dbAdmin: pg.Client;

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

function post(path: string, body: unknown, tkn: string = ownerToken) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tkn}` },
    body: JSON.stringify(body),
  });
}

async function uploadOneFailure(message: string): Promise<void> {
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suiteName,
        branch: "main",
        commit_sha: crypto.randomUUID().slice(0, 8),
        ci_run_id: `ci-fixpr-${crypto.randomUUID()}`,
        started_at: "2026-05-01T00:00:00Z",
        finished_at: "2026-05-01T00:00:30Z",
        reporter: "mochawesome",
      },
      stats: { total: 1, passed: 0, failed: 1, skipped: 0, pending: 0, duration_ms: 30000 },
      specs: [
        {
          file_path: "src/widget.spec.ts",
          title: "widget",
          stats: { total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 30000 },
          tests: [
            {
              title: "renders",
              full_title: `Widget > renders ${crypto.randomUUID()}`,
              status: "failed",
              duration_ms: 10,
              screenshot_paths: [],
              error: { message, stack: "at widget.spec.ts:1" },
            },
          ],
        },
      ],
    })
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "fixpr-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Force AI off so the AI-gate assertions are deterministic.
      AI_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      AI_BASE_URL: "",
      AI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Owner of a fresh org.
  const email = `fixpr+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "FixPR", org_name: `FixPROrg-${Date.now()}` }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  const regData = (await reg.json()) as { token: string; user: { orgId: number } };
  ownerToken = regData.token;
  orgId = regData.user.orgId;

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  suiteName = `fixpr-suite-${Date.now()}`;
  await uploadOneFailure("TypeError: cannot read property 'x' of undefined");

  // Resolve a real failed-test id + its fingerprint from our uploaded data.
  fingerprint = crypto.createHash("md5")
    .update(`TypeError: cannot read property 'x' of undefined|${suiteName}`)
    .digest("hex");
  const listed = await fetch(`${BASE}/errors/${fingerprint}/tests`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const tests = (await listed.json()) as Array<{ latest_test_id: number }>;
  if (!tests.length || !tests[0].latest_test_id) throw new Error("no failed test id resolved");
  failedTestId = tests[0].latest_test_id;

  // A viewer member of the same org (direct DB insert; superuser bypasses RLS).
  const viewerEmail = `fixpr-viewer+${Date.now()}@test.local`;
  const vreg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: viewerEmail, password: "testpass123", name: "Viewer", org_name: `Throwaway-${Date.now()}` }),
  });
  const vData = (await vreg.json()) as { token: string; user: { id: number } };
  // Drop the throwaway org's owner membership and add a viewer membership in OUR
  // org, so it becomes the user's only (hence earliest-joined) membership —
  // resolveOrg() orders by joined_at, so a re-login then resolves to our org as
  // a viewer.
  await dbAdmin.query(`DELETE FROM org_members WHERE user_id = $1`, [vData.user.id]);
  await dbAdmin.query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'viewer')`,
    [orgId, vData.user.id]
  );
  const vlogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: viewerEmail, password: "testpass123" }),
  });
  const vlData = (await vlogin.json()) as { token: string };
  viewerToken = vlData.token;
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Selector validation (runs before every other gate) ────────────────────

test("POST /analyze/fix-pr 400s when neither testId nor fingerprint is provided", async () => {
  const res = await post(`/analyze/fix-pr`, {});
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Provide exactly one of testId or fingerprint");
});

test("POST /analyze/fix-pr 400s when BOTH testId and fingerprint are provided", async () => {
  const res = await post(`/analyze/fix-pr`, { testId: failedTestId, fingerprint });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Provide exactly one of testId or fingerprint");
});

// ── Viewer block (contributor+ only) ───────────────────────────────────────

test("POST /analyze/fix-pr 403s for a viewer", async () => {
  const res = await post(`/analyze/fix-pr`, { testId: failedTestId }, viewerToken);
  assert.equal(res.status, 403);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Contributor role required to generate AI analysis");
});

// ── Provider gate (no git provider configured) ─────────────────────────────

test("POST /analyze/fix-pr 409s when no git provider is configured", async () => {
  // The org has no git provider set, so resolution succeeds but the provider
  // gate trips before the AI gate.
  const res = await post(`/analyze/fix-pr`, { testId: failedTestId });
  assert.equal(res.status, 409);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "No git provider configured");
});

test("POST /analyze/fix-pr 404s for an unknown test id (resolution precedes the provider gate)", async () => {
  const res = await post(`/analyze/fix-pr`, { testId: 2000000000 });
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Failed test with an error message not found");
});

// ── AI gate (provider configured, AI off) ──────────────────────────────────

test("POST /analyze/fix-pr 503s when a git provider IS configured but AI is off", async () => {
  // Configure a syntactically valid GitHub provider directly in the DB
  // (organizations has no RLS). With a provider present, the route advances past
  // the 409 to the AI gate — and AI is off, so it 503s WITHOUT any network call
  // (getProviderForOrg only reads the DB; the first network hit would be
  // getDefaultBranch(), which we never reach).
  await dbAdmin.query(
    `UPDATE organizations SET git_provider = 'github', git_token = $2, git_repo = 'acme/widgets' WHERE id = $1`,
    [orgId, "v1:" + Buffer.from("iv").toString("base64") + ":" + Buffer.from("tag").toString("base64") + ":" + Buffer.from("ct").toString("base64")]
  );

  const res = await post(`/analyze/fix-pr`, { testId: failedTestId });
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "AI analysis requires an AI provider to be configured");

  // Reset so other tests see no provider (defensive — this is the last test).
  await dbAdmin.query(
    `UPDATE organizations SET git_provider = NULL, git_token = NULL, git_repo = NULL WHERE id = $1`,
    [orgId]
  );
});
