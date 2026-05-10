/**
 * Refresh-token revocation + rotation smoke.
 *
 * Migration 037 added revoked_refresh_tokens; routes/auth.ts now:
 *
 *   - signs every refresh token with a unique jti claim
 *   - /auth/logout reads the current refresh token from the body
 *     or the flakey_refresh cookie, parses its jti, and inserts
 *     it into revoked_refresh_tokens (idempotent on conflict)
 *   - /auth/refresh consults revoked_refresh_tokens BEFORE
 *     issuing a new pair, and on successful refresh marks the
 *     consumed jti as revoked (rotation).
 *
 * What this file pins:
 *
 *   1. After /auth/logout with a refresh token, /auth/refresh with
 *      that same token 401s — a captured token doesn't survive logout.
 *   2. Refresh-token rotation: after a successful /auth/refresh, the
 *      old refresh token cannot be replayed. The NEW refresh works
 *      once. A captured refresh token therefore self-detects on
 *      replay (the legitimate user's next refresh 401s if the
 *      attacker raced ahead, or vice versa).
 *   3. Logout is idempotent: a second logout with the same body /
 *      cookie does not 5xx. The user's session-state-tidying is
 *      always allowed.
 *   4. Logout without any refresh token (body + cookie both empty)
 *      still 200s — the route is fail-open on the revocation side
 *      because there's nothing to revoke.
 *   5. Revocation is per-token: user A's logout does NOT invalidate
 *      user B's refresh token even if they were issued back-to-back.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3983;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

interface Session {
  email: string;
  password: string;
  token: string;
  refreshToken: string;
  userId: number;
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

async function registerSession(label: string): Promise<Session> {
  const email = `session+${label}+${Date.now()}@test.local`;
  const password = "testpass123";
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: `Session-${label}`,
      org_name: `SessionOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as {
    token: string;
    refreshToken: string;
    user: { id: number };
  };
  return { email, password, token: data.token, refreshToken: data.refreshToken, userId: data.user.id };
}

async function postRefresh(refreshToken: string): Promise<Response> {
  return fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
}

async function postLogout(refreshToken?: string): Promise<Response> {
  return fetch(`${BASE}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(refreshToken ? { refreshToken } : {}),
  });
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "session-revocation-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
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

// ── /auth/logout revokes the refresh token ──────────────────────────────

test("after /auth/logout, /auth/refresh with the revoked refresh token returns 401", async () => {
  const s = await registerSession("logout-revokes");

  // Sanity: the freshly-issued refresh works before logout.
  const before = await postRefresh(s.refreshToken);
  assert.equal(before.status, 200, "fresh refresh should succeed before logout (sanity control)");
  // Note: the successful refresh ABOVE has rotated the token,
  // so s.refreshToken is now revoked. Capture the new one.
  const rotated = ((await before.json()) as { refreshToken: string }).refreshToken;

  const logout = await postLogout(rotated);
  assert.equal(logout.status, 200, "logout should always 200");

  const after = await postRefresh(rotated);
  assert.equal(after.status, 401, "the just-logged-out refresh token must 401 on /auth/refresh");
});

// ── /auth/refresh rotation: the consumed token is revoked on next use ───

test("/auth/refresh rotates: replaying the old refresh token after a successful refresh returns 401", async () => {
  const s = await registerSession("rotation");

  // First refresh consumes s.refreshToken and returns a new one.
  const first = await postRefresh(s.refreshToken);
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { refreshToken: string };

  // Replay the ORIGINAL refresh token — this is what an attacker
  // would do with a stolen token after the legitimate user has
  // already refreshed. Must 401 (rotation detected the replay).
  const replay = await postRefresh(s.refreshToken);
  assert.equal(
    replay.status,
    401,
    "the previously-consumed refresh token must 401 on replay — refresh-token rotation must be active",
  );

  // The NEW refresh token works, and itself rotates.
  const second = await postRefresh(firstBody.refreshToken);
  assert.equal(second.status, 200, "the rotated refresh token must work once");
  const secondReplay = await postRefresh(firstBody.refreshToken);
  assert.equal(secondReplay.status, 401, "the rotated refresh token must also self-revoke after its single use");
});

// ── Logout is idempotent + tolerant of missing input ────────────────────

test("/auth/logout is idempotent: a second logout with the same refresh token does not 5xx", async () => {
  const s = await registerSession("idempotent-logout");

  const first = await postLogout(s.refreshToken);
  assert.equal(first.status, 200);

  const second = await postLogout(s.refreshToken);
  assert.ok(
    second.status < 500,
    `repeated logout must not 5xx; got ${second.status}. The ON CONFLICT DO NOTHING in the revocation insert should keep it idempotent`,
  );
});

test("/auth/logout with no refresh token still returns 200 (nothing to revoke is a no-op)", async () => {
  const res = await postLogout();
  assert.equal(res.status, 200, "logout with no refresh token should not 400 or 401 — it's a session-tidy operation");
});

// ── Per-token scoping: one user's logout does not invalidate another ────

test("/auth/logout is per-token: user A's logout does NOT invalidate user B's refresh token", async () => {
  const a = await registerSession("scope-a");
  const b = await registerSession("scope-b");

  // Log A out.
  await postLogout(a.refreshToken);

  // B's refresh must still work — the revocation is keyed by jti,
  // not user-globally. Anything else means a buggy revocation
  // matches across users.
  const res = await postRefresh(b.refreshToken);
  assert.equal(res.status, 200, "user B's refresh must still succeed after user A logs out — revocation is per-token, not per-user");
});

// ── Revocation list applies to BOTH cookie and body paths ──────────────

test("/auth/logout via the flakey_refresh cookie revokes the same token an explicit body POST would", async () => {
  const s = await registerSession("cookie-logout");

  // Simulate the browser case: send the refresh token in the
  // flakey_refresh cookie (no body field). The route should
  // parse it and revoke its jti just the same.
  const logout = await fetch(`${BASE}/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `flakey_refresh=${s.refreshToken}`,
    },
    body: JSON.stringify({}),
  });
  assert.equal(logout.status, 200);

  const after = await postRefresh(s.refreshToken);
  assert.equal(
    after.status,
    401,
    "logout via the flakey_refresh cookie must revoke the same way as a body POST — otherwise the browser-side logout is silently no-op",
  );
});
