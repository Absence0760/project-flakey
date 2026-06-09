/**
 * Smoke tests for POST /analyze/clusters (src/routes/analyze.ts).
 *
 * Clustering is deterministic similarity (cost-free, AI-independent): the route
 * groups the org's distinct failed errors with clusterBySimilarity() and only
 * reaches for the model to LABEL a multi-member cluster. So with AI off the
 * endpoint must still return clusters — never 503 — with theme=null/summary=null,
 * and any already-cached theme must be served from the DB regardless of AI config.
 *
 * The AI provider is OFF in this env (no AI_PROVIDER / ANTHROPIC_API_KEY) and we
 * do NOT mock one. We assert:
 *   - AI off → 200 with clusters whose theme/summary are null (no 503).
 *   - A pre-seeded cluster-theme cache row (target_type='cluster') is returned
 *     on its matching cluster, even with AI off.
 *
 * Each test owns its org + data so assertions are independent of seed data and
 * of parallel test agents.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import pg from "pg";

const PORT = 3952;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let orgId: number;
let suiteName: string;
let dbAdmin: pg.Client;

// Two near-identical messages that clusterBySimilarity (threshold 0.4) groups
// together, plus a clearly-unrelated one that forms its own singleton cluster.
// vs each other: intersection {timeout,waiting,for,selector}=4, max=5 => 0.8 (clustered)
const CLUSTER_A = "timeout waiting for selector button";
const CLUSTER_B = "timeout waiting for selector link";
const LONER = "assertion failed expected true got false";

function fingerprintOf(message: string, suite: string): string {
  return crypto.createHash("md5").update(`${message}|${suite}`).digest("hex");
}

// Mirror analyze.ts clusterKey(): md5 of the SORTED member fingerprints.
function clusterKeyOf(fingerprints: string[]): string {
  return crypto.createHash("md5").update([...fingerprints].sort().join(",")).digest("hex");
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

function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function uploadFailures(messages: string[]): Promise<void> {
  const fd = new FormData();
  const tests = messages.map((message, i) => ({
    title: `case ${i}`,
    full_title: `Suite > case ${i} ${crypto.randomUUID()}`,
    status: "failed",
    duration_ms: 10,
    screenshot_paths: [],
    error: { message, stack: "at line 1" },
  }));
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suiteName,
        branch: "main",
        commit_sha: crypto.randomUUID().slice(0, 8),
        ci_run_id: `ci-clusters-${crypto.randomUUID()}`,
        started_at: "2026-05-02T00:00:00Z",
        finished_at: "2026-05-02T00:00:30Z",
        reporter: "mochawesome",
      },
      stats: { total: messages.length, passed: 0, failed: messages.length, skipped: 0, pending: 0, duration_ms: 30000 },
      specs: [
        {
          file_path: "clusters.cy.ts",
          title: "clusters",
          stats: { total: messages.length, passed: 0, failed: messages.length, skipped: 0, duration_ms: 30000 },
          tests,
        },
      ],
    })
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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
      JWT_SECRET: "clusters-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
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

  const email = `clusters+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "Clusters", org_name: `ClustersOrg-${Date.now()}` }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  const regData = (await reg.json()) as { token: string; user: { orgId: number } };
  token = regData.token;
  orgId = regData.user.orgId;

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  suiteName = `clusters-suite-${Date.now()}`;
  await uploadFailures([CLUSTER_A, CLUSTER_B, LONER]);
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("GET /analyze/status reports AI disabled in the test env", async () => {
  const res = await fetch(`${BASE}/analyze/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { enabled: boolean };
  assert.equal(data.enabled, false, "AI must be disabled in the test env for these assertions to hold");
});

test("POST /analyze/clusters returns clusters with null themes (never 503) when AI is off", async () => {
  const res = await post(`/analyze/clusters`, {});
  assert.equal(res.status, 200, "clustering is deterministic — it must not 503 with AI off");
  const data = (await res.json()) as {
    clusters: Array<{
      target_key: string;
      theme: string | null;
      summary: string | null;
      member_count: number;
      members: Array<{ fingerprint: string; error_message: string }>;
    }>;
  };
  assert.ok(Array.isArray(data.clusters), "response must carry a clusters array");

  // The two similar errors must land in one multi-member cluster.
  const multi = data.clusters.find((c) => c.member_count >= 2);
  assert.ok(multi, "the two similar errors should group into a multi-member cluster");
  // AI off → no theme/summary generated for any cluster.
  for (const c of data.clusters) {
    assert.equal(c.theme, null, "theme must be null with AI off and no cache");
    assert.equal(c.summary, null, "summary must be null with AI off and no cache");
  }

  // The loner forms its own singleton cluster.
  assert.ok(data.clusters.some((c) => c.member_count === 1), "the unrelated error should be a singleton cluster");
});

test("POST /analyze/clusters serves a pre-seeded cluster theme from cache even with AI off", async () => {
  const fpA = fingerprintOf(CLUSTER_A, suiteName);
  const fpB = fingerprintOf(CLUSTER_B, suiteName);
  const targetKey = clusterKeyOf([fpA, fpB]);

  // Seed a cluster theme directly (AI is off, so the route can't write one).
  await dbAdmin.query(
    `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, raw_result)
     VALUES ($1, 'cluster', $2, $3, $4, $5)
     ON CONFLICT (org_id, target_type, target_key) DO UPDATE
       SET classification = EXCLUDED.classification, summary = EXCLUDED.summary`,
    [orgId, targetKey, "Selector timeouts", "All these failures time out waiting for a selector.", JSON.stringify({ theme: "Selector timeouts" })]
  );

  const res = await post(`/analyze/clusters`, {});
  assert.equal(res.status, 200);
  const data = (await res.json()) as { clusters: Array<{ target_key: string; theme: string | null; summary: string | null }> };

  const labeled = data.clusters.find((c) => c.target_key === targetKey);
  assert.ok(labeled, "the seeded cluster (by its sorted-fingerprint key) must be present");
  assert.equal(labeled!.theme, "Selector timeouts", "the cached theme must be served even with AI off");
  assert.equal(labeled!.summary, "All these failures time out waiting for a selector.");
});
