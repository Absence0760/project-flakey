/**
 * GET /auth/registration-status — the public read for self-serve posture.
 *
 * The SPA landing page fetches this on mount so it can hide the
 * "Create an account" CTA when the backend is closed for self-serve.
 * Two test servers spawned, one per posture, so we cover both
 * branches of the endpoint without mutating env mid-process.
 *
 * Pinned guarantees:
 *   1. Endpoint is PUBLIC (no Authorization header needed) — adding
 *      requireAuth to /auth/* by accident would break the landing
 *      page silently.
 *   2. {open: true} when ALLOW_REGISTRATION=true. {open: false}
 *      otherwise (the production-default posture).
 *   3. Response shape is exactly `{ open: boolean }` — anything
 *      richer would invite landing-page drift.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

type Server = { proc: ChildProcess; port: number };

async function waitForHealth(port: number, maxMs = 10000): Promise<void> {
  const base = `http://localhost:${port}`;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Backend on :${port} did not become healthy`);
}

async function spawnServer(port: number, env: Record<string, string>): Promise<Server> {
  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "reg-status-test",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
      ...env,
    } as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth(port);
  return { proc, port };
}

// Pick ports nothing else in src/tests/ uses (grep confirmed unique).
const PORT_OPEN = 3961;
const PORT_CLOSED = 3964;

let serverOpen: Server;
let serverClosed: Server;

before(async () => {
  serverOpen = await spawnServer(PORT_OPEN, { ALLOW_REGISTRATION: "true" });
  serverClosed = await spawnServer(PORT_CLOSED, {});
});

after(async () => {
  for (const s of [serverOpen, serverClosed]) {
    if (s && !s.proc.killed) {
      s.proc.kill("SIGTERM");
      await once(s.proc, "exit").catch(() => {});
    }
  }
});

test("GET /auth/registration-status is PUBLIC (no auth header required)", async () => {
  const res = await fetch(`http://localhost:${PORT_OPEN}/auth/registration-status`);
  assert.equal(res.status, 200, "endpoint must be reachable without a Bearer token");
});

test("GET /auth/registration-status returns {open: true} when ALLOW_REGISTRATION=true", async () => {
  const res = await fetch(`http://localhost:${PORT_OPEN}/auth/registration-status`);
  const body = (await res.json()) as { open: boolean };
  assert.equal(body.open, true);
});

test("GET /auth/registration-status returns {open: false} when ALLOW_REGISTRATION is unset (production-default closed posture)", async () => {
  const res = await fetch(`http://localhost:${PORT_CLOSED}/auth/registration-status`);
  const body = (await res.json()) as { open: boolean };
  assert.equal(body.open, false);
});

test("response shape is exactly { open: boolean } — no extra fields that the SPA might drift on", async () => {
  const res = await fetch(`http://localhost:${PORT_OPEN}/auth/registration-status`);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["open"]);
  assert.equal(typeof body.open, "boolean");
});
