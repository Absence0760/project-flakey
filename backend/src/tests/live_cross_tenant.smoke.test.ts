/**
 * Cross-tenant isolation for the /live/* endpoints.
 *
 * cross_tenant.smoke.test.ts covers GET /live/active (org-scoped
 * in-memory registry) and GET /live/:id/stream (SSE-bus tenant gate).
 * The remaining six /live/* endpoints all guard ownership via
 * tenantQuery in routes/live.ts — but none of them had explicit
 * cross-org tests until this file. A regression in any one of them
 * leaks live events, screenshots, snapshot DOM dumps, or abort
 * signals between organizations.
 *
 * Each test creates a live run owned by org A, then attempts a
 * tenant-sensitive operation from org B and asserts the route
 * returns 404 — the same shape /live/<id>/stream returns to keep
 * existence indistinguishable from absence across tenants.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3993;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let tokenA: string;
let tokenB: string;
let runIdA: number;

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

async function registerOrg(label: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `live-iso+${label}+${Date.now()}@test.local`,
      password: "testpass123",
      name: `Live-Iso-${label}`,
      org_name: `LiveIsoOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`register ${label} failed: ${res.status} ${body}`);
  }
  return ((await res.json()) as { token: string }).token;
}

function jsonHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      // RLS bypass-check: connect as flakey_app (NOT the superuser
      // 'flakey'). Superusers bypass RLS, so changing this would make
      // every test in this file pass for the wrong reason.
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "live-cross-tenant-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Long enough that the live run created in setup never trips
      // the stale-run timer mid-test.
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  tokenA = await registerOrg("a");
  tokenB = await registerOrg("b");

  const startA = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: jsonHeaders(tokenA),
    body: JSON.stringify({ suite: `live-iso-${Date.now()}` }),
  });
  if (!startA.ok) throw new Error(`/live/start failed: ${startA.status}`);
  runIdA = ((await startA.json()) as { id: number }).id;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── /live/:id mutations from a foreign tenant must 404 ──────────────────

test("POST /live/:id/events from org B 404s on org A's run (no event injection)", async () => {
  const res = await fetch(`${BASE}/live/${runIdA}/events`, {
    method: "POST",
    headers: jsonHeaders(tokenB),
    body: JSON.stringify([
      { type: "test.passed", spec: "leak.cy.ts", test: "cross-org poison", duration_ms: 1 },
    ]),
  });
  assert.equal(
    res.status,
    404,
    "events POST across the org boundary must 404 — anything else means org B can poison org A's SSE bus and write rows under org A's run",
  );
});

test("POST /live/:id/abort from org B 404s on org A's run (no remote-kill)", async () => {
  const res = await fetch(`${BASE}/live/${runIdA}/abort`, {
    method: "POST",
    headers: jsonHeaders(tokenB),
    body: JSON.stringify({ reason: "cross-org abort attempt" }),
  });
  assert.equal(
    res.status,
    404,
    "abort POST across the org boundary must 404 — anything else means org B can kill org A's live runs",
  );
});

test("GET /live/:id/history from org B 404s on org A's run (no event replay leak)", async () => {
  const res = await fetch(`${BASE}/live/${runIdA}/history`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(
    res.status,
    404,
    "history GET across the org boundary must 404 — a 200 with [] would still leak run-id validity",
  );
});

test("POST /live/:id/snapshot from org B 404s on org A's run (no DOM dump injection)", async () => {
  // Minimal multipart body. Multer parses the file BEFORE the route
  // handler runs the tenant check, so a temp file may briefly land
  // in uploads/tmp/ — the route's 404 prevents promotion to
  // long-term storage, which is the contract under test here.
  const fd = new FormData();
  fd.append("snapshot", new Blob([new Uint8Array([0x1f, 0x8b, 0x08, 0x00])]), "leak.json.gz");
  fd.append("spec", "leak.cy.ts");
  fd.append("testTitle", "cross-org snapshot");
  const res = await fetch(`${BASE}/live/${runIdA}/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenB}` },
    body: fd,
  });
  assert.equal(
    res.status,
    404,
    "snapshot upload across the org boundary must 404 — anything else means org B can attach DOM dumps to org A's tests",
  );
});

test("POST /live/:id/screenshot from org B 404s on org A's run (no artifact injection)", async () => {
  const fd = new FormData();
  fd.append("screenshot", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "leak.png");
  fd.append("spec", "leak.cy.ts");
  fd.append("testTitle", "cross-org screenshot");
  const res = await fetch(`${BASE}/live/${runIdA}/screenshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenB}` },
    body: fd,
  });
  assert.equal(
    res.status,
    404,
    "screenshot upload across the org boundary must 404 — anything else means org B can attach files to org A's tests",
  );
});

// ── /live/start owns its run; never collides across tenants ─────────────

test("POST /live/start from org B allocates a fresh id, never colliding with org A's run", async () => {
  // /live/start is org-scoped: it always INSERTs a new runs row
  // owned by the caller's org. The id is sequence-allocated so a
  // cross-org collision shouldn't be possible, but pin it down
  // explicitly so a future change (e.g. switching to a content-hash
  // id, accidentally) doesn't silently let org B's start "land on"
  // org A's run.
  const res = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: jsonHeaders(tokenB),
    body: JSON.stringify({ suite: `org-b-${Date.now()}` }),
  });
  assert.equal(res.status, 201, "org B's /live/start should succeed for its own org");
  const body = (await res.json()) as { id: number };
  assert.notEqual(
    body.id,
    runIdA,
    "org B's /live/start must allocate a fresh runs.id; aliasing onto org A's id would collapse two tenants onto one row",
  );

  // And from org B's vantage, org A's run is invisible — GET /runs
  // /live/active should not include runIdA. This is already pinned
  // by cross_tenant.smoke.test.ts:482; re-asserting cheaply here
  // catches a regression that breaks only the post-start polling
  // (e.g. the in-memory active set leaking across orgs).
  const active = await fetch(`${BASE}/live/active`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(active.status, 200);
  const activeBody = (await active.json()) as { runs: number[] };
  assert.ok(
    !activeBody.runs.includes(runIdA),
    "org A's run id must not appear in org B's /live/active list",
  );
});
