/**
 * CORS enforcement in production mode.
 *
 * src/index.ts uses a single whitelist callback in every environment
 * now (the dev/prod split that reflected the request Origin was the
 * subject of CodeQL js/cors-permissive-configuration and got removed
 * in a5956ce). ALLOWED_ORIGINS defaults to the two localhost ports
 * the dev frontend uses; in production CORS_ORIGINS is required.
 *
 * What's pinned here:
 *   1. A preflight (OPTIONS) request from an Origin NOT in
 *      CORS_ORIGINS gets no Access-Control-Allow-Origin header. The
 *      browser then refuses the cross-origin call — without ACAO the
 *      response can't be read by the foreign-origin script even if
 *      the server processed it.
 *   2. A simple (GET) request from a non-allowed Origin also gets no
 *      ACAO. Even though the body fires off the wire, the browser
 *      drops it before delivery, so the leak is gated.
 *   3. An allowed Origin (one of the values in CORS_ORIGINS) gets
 *      the ACAO header echoed back with credentials: true. This is
 *      the happy path — the prod frontend at https://app.example.com
 *      needs this to work.
 *   4. Requests with no Origin header (server-to-server, curl) pass
 *      through unblocked — the CORS callback's `if (!origin)` branch
 *      is what keeps CI integrations + health probes alive.
 *
 * The spawn uses NODE_ENV=production + a specific allow-list so the
 * test pins the production behaviour. JWT_SECRET is required in prod
 * or the backend exits at startup; CORS_ORIGINS pins the allowed set.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

// Outside the 3971-3999 band the other smokes use.
const PORT = 3962;
const BASE = `http://localhost:${PORT}`;
const ALLOWED = "https://app.example.com";
const DISALLOWED = "https://evil.example.com";

let server: ChildProcess;

async function waitForHealth(maxMs = 10_000): Promise<void> {
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
      JWT_SECRET: "cors-prod-test-secret",
      // Required by the production-mode boot guard (added in
      // backend/src/index.ts). Throwaway value — this test only
      // exercises CORS, never reads/writes encrypted secrets.
      FLAKEY_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // gitleaks:allow — deterministic test fixture, not a real secret
      NODE_ENV: "production",
      // The unit under test.
      CORS_ORIGINS: ALLOWED,
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
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
});

// ── 1. Disallowed-origin preflight ─────────────────────────────────────

test("OPTIONS preflight from a non-allowed Origin returns no Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: DISALLOWED,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  // Without ACAO the browser refuses the actual cross-origin call.
  // The cors package returns 500 (Error("CORS not allowed")) for the
  // callback's reject branch — accept either 500 (callback path) or
  // 204 (preflight short-circuit) as long as ACAO is absent.
  assert.equal(res.headers.get("access-control-allow-origin"), null,
    "ACAO must not echo a non-allowed Origin");
});

// ── 2. Disallowed-origin simple request ────────────────────────────────

test("GET from a non-allowed Origin returns no Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { Origin: DISALLOWED },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null,
    "ACAO must not echo a non-allowed Origin on a simple GET either");
});

// ── 3. Allowed-origin happy path ───────────────────────────────────────

test("OPTIONS preflight from CORS_ORIGINS gets the Origin echoed in ACAO + credentials true", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED,
    "ACAO must echo the allowed Origin verbatim (not '*', because credentials:true)");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true",
    "ACAC must be 'true' so the frontend can send the bt_token cookie");
});

test("GET from CORS_ORIGINS gets ACAO on the simple-request path too", async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { Origin: ALLOWED },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
});

// ── 4. No-Origin (server-to-server) request is unblocked ───────────────

test("request without an Origin header (curl / server-to-server) is allowed through", async () => {
  // No Origin set; the cors callback's `if (!origin)` branch lets it
  // through. /health stays reachable for ALB health probes, ELB
  // synthetic checks, uptime monitors, etc., even in prod.
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
});
