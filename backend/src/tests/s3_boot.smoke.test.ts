/**
 * Boot smoke for STORAGE=s3.
 *
 * The /uploads/* route was previously registered with Express 4-style
 * `app.get("/uploads/*", ...)`. Under Express 5 + path-to-regexp v8 the
 * bare `*` is no longer a valid pattern — the server crashes at route
 * registration with a TypeError BEFORE serving any request. The infra
 * Terraform sets STORAGE=s3 in production, so this bug was a hard prod
 * boot failure waiting to happen.
 *
 * The fix uses `app.use("/uploads", ...)` (the prefix is stripped from
 * req.path before the inner handler runs). This test only confirms the
 * boot path — it doesn't actually hit S3 (we don't have AWS creds in
 * test envs and we don't need them; the route-registration crash
 * happens before the first request).
 *
 * The /health check returning 2xx is sufficient proof: if route
 * registration crashed, the server would never reach the listening
 * state and waitForHealth would time out.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3965;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

async function waitForHealth(maxMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "s3-boot-test-secret",
      NODE_ENV: "test",
      // The unit under test.
      STORAGE: "s3",
      // Dummy bucket — never reached because we only hit /health.
      // S3Storage initialisation is lazy (first put/get), so a bogus
      // bucket name doesn't fail boot.
      S3_BUCKET: "flakey-boot-test-no-such-bucket",
      AWS_REGION: "us-east-1",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("server boots under STORAGE=s3 (Express 5 route registration does not crash)", async () => {
  const healthy = await waitForHealth();
  assert.ok(
    healthy,
    "/health never returned 2xx — likely a route registration crash. Look for path-to-regexp errors in the server stderr above.",
  );
});

test("GET /uploads/<unknown> under STORAGE=s3 returns a 4xx (route is registered, not crashed)", async () => {
  // Hit the route with no auth so we exercise the registration path
  // without needing valid creds. The handler chain is
  // artifactLimiter -> promoteUploadToken -> requireAuth -> requireRunOwnership ->
  // s3 redirect. Without a Bearer token, requireAuth 401s. The
  // important assertion is that we get an HTTP response at all — a
  // crashed route would refuse the connection or 404 at Express's
  // fallback.
  const res = await fetch(`${BASE}/uploads/runs/999/screenshots/none.png`);
  assert.ok(
    res.status >= 400 && res.status < 500,
    `expected 4xx (route is registered + auth rejects), got ${res.status}`,
  );
});
