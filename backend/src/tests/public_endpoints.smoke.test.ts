/**
 * Smoke tests for public/unauthenticated endpoints.
 *
 * These routes (badge SVG, health) are meant to be embedded in
 * READMEs/dashboards without an Authorization header. They are also
 * the most-likely-to-have-RLS-bugs because they use `pool.query`
 * directly — which under FORCE ROW LEVEL SECURITY returns zero rows
 * unless the org context has been set first via tenantQuery() or an
 * explicit set_config().
 *
 * The previous round of tests caught the same RLS-bypass class of bug
 * in the test setup itself (using superuser `flakey`). This file goes
 * after the public endpoints, which can't use tenantQuery because they
 * have no req.user.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3995;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let orgSlug: string;
let suiteName: string;

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

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "public-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Register an org and upload a run with known stats so the badge has
  // something deterministic to render.
  const orgName = `BadgeOrg-${Date.now()}`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `badge+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Badge",
      org_name: orgName,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const data = (await reg.json()) as { token: string; user: { orgId: number } };
  const token = data.token;

  // Read back the org's slug — it's auto-generated from the org name.
  const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const meData = (await me.json()) as { orgs: Array<{ id: number; slug: string }> };
  orgSlug = meData.orgs.find((o) => o.id === data.user.orgId)!.slug;

  suiteName = `badge-suite-${Date.now()}`;
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suiteName,
        branch: "main",
        commit_sha: "badge-sha",
        ci_run_id: `badge-ci-${Date.now()}`,
        started_at: "2026-04-10T00:00:00Z",
        finished_at: "2026-04-10T00:00:10Z",
        reporter: "mochawesome",
      },
      stats: { total: 7, passed: 5, failed: 2, skipped: 0, pending: 0, duration_ms: 1000 },
      specs: [
        {
          file_path: "a.js",
          title: "a",
          stats: { total: 7, passed: 5, failed: 2, skipped: 0, duration_ms: 1000 },
          tests: Array.from({ length: 7 }, (_, i) => ({
            title: `t-${i}`,
            full_title: `t-${i}`,
            status: i < 5 ? "passed" : "failed",
            duration_ms: 100,
            screenshot_paths: [],
          })),
        },
      ],
    })
  );
  const runRes = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!runRes.ok) throw new Error(`run upload failed: ${runRes.status}`);
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("GET /health is reachable without auth", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
});

test("GET /badge/:orgSlug/:suiteName returns SVG with the actual stats (RLS-aware)", async () => {
  // No Authorization header — badges are embedded in READMEs.
  const res = await fetch(`${BASE}/badge/${orgSlug}/${encodeURIComponent(suiteName)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);

  const body = await res.text();
  assert.match(body, /^<svg/, "expected an SVG body");

  // The bug we're locking down: this endpoint uses pool.query directly,
  // which under FORCE ROW LEVEL SECURITY returns zero rows unless the
  // app.current_org_id session GUC has been set first.  If the route
  // forgets to set it, the badge will silently render "no data" even
  // though we just uploaded a 7-test run.
  assert.ok(
    !body.includes(">no data<"),
    'badge says "no data" — pool.query is hitting RLS without app.current_org_id being set'
  );
  // The run had 2 failed tests, so we expect the failure variant.
  assert.match(body, /2 failed/, "expected the badge to render the failure count from the just-uploaded run");
});

test("GET /badge/:orgSlug/:suiteName for an unknown org renders 'not found' (no leak)", async () => {
  const res = await fetch(`${BASE}/badge/this-org-does-not-exist/anything`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /not found/, "unknown org should render 'not found' badge");
});

test("GET /badge/:orgSlug/:suiteName for an unknown suite renders 'no data'", async () => {
  const res = await fetch(`${BASE}/badge/${orgSlug}/this-suite-was-never-uploaded`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /no data/, "unknown suite should render 'no data' badge");
});

test("GET /badge escapes XML metacharacters in suite names (XSS in the SVG)", async () => {
  // Embed an XML-injection attempt in the URL path.  The route should
  // either render the suite as no-data (preferred — rejects unknown
  // names) or escape the chars; either way the literal `<script>` tag
  // must NOT appear unescaped in the body.
  const malicious = "<script>alert(1)</script>";
  const res = await fetch(`${BASE}/badge/${orgSlug}/${encodeURIComponent(malicious)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes("<script>"), "badge SVG contains an unescaped <script> tag — XSS risk");
});
