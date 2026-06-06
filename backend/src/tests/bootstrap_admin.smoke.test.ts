/**
 * Env-gated first-admin bootstrap.
 *
 * F4: migration 003 used to seed a known-credential admin
 * (admin@example.com / "admin") on every fresh DB, so a fresh
 * production install shipped with a publicly-known login. That INSERT
 * is gone; the first admin now comes from the boot-time bootstrap when
 * FLAKEY_BOOTSTRAP_ADMIN_EMAIL + FLAKEY_BOOTSTRAP_ADMIN_PASSWORD are
 * both set (src/bootstrap-admin.ts).
 *
 * This spawns the server with a UNIQUE bootstrap email + password, waits
 * for health (bootstrap runs in the listen callback), then asserts the
 * bootstrapped credentials log in and the user has role 'admin'.
 *
 * 3967 is outside the 3971-3999 band the other smokes use; 3962/3963/
 * 3964/3965/3966/3968 are also taken.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3967;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = "bootstrap-admin-smoke-secret";

// Unique per run so re-runs don't collide with a prior bootstrapped row
// (the seed DB is shared; the bootstrap is idempotent on existing email).
const ADMIN_EMAIL = `bootstrap+${Date.now()}@test.local`;
const ADMIN_PASSWORD = "bootstrap-pass-123";

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
      JWT_SECRET,
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
      FLAKEY_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
      FLAKEY_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
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

// The bootstrap runs in the listen callback; health may go green a tick
// before it commits. Poll login briefly so we wait on the real signal
// (a successful auth) rather than racing the bootstrap insert.
async function loginAdmin(maxMs = 5_000): Promise<Response> {
  const start = Date.now();
  let last: Response | undefined;
  while (Date.now() - start < maxMs) {
    last = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last!;
}

test("bootstrapped admin can log in with the supplied credentials and has role admin", async () => {
  const res = await loginAdmin();
  assert.equal(res.status, 200, `login should succeed; got ${res.status} ${await res.clone().text()}`);

  const data = (await res.json()) as { token: string; user: { email: string; role: string; orgId: number } };
  assert.ok(data.token, "login response must include a JWT");
  assert.equal(data.user.email, ADMIN_EMAIL, "logged-in user is the bootstrapped admin");
  assert.equal(data.user.role, "admin", "bootstrapped user must have role 'admin'");
  assert.ok(Number.isInteger(data.user.orgId), "bootstrapped admin must belong to an org (owner membership)");
});

test("a password the bootstrap did NOT set is rejected", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong-password" }),
  });
  assert.equal(res.status, 401, "a wrong password must not authenticate the bootstrapped admin");
});
