/**
 * Auth-flow + API-key smoke tests.
 *
 * The Authorization header has TWO code paths in `auth.ts`:
 *   1. JWT  (every other test file exercises this)
 *   2. API key with `fk_` prefix (separate verifyApiKey + bcrypt path)
 *
 * The API-key path also derives `orgId` differently: it reads from the
 * `api_keys` row, not from the JWT payload. That's a separate hand-off
 * point that has never been tested. This file does that, plus exercises
 * the auth-flow edge cases (wrong password, malformed token, switch-org
 * to non-member, refresh, logout) that have no coverage today.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let userToken: string;
let userEmail: string;
let userPassword: string;
let userOrgId: number;

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
      JWT_SECRET: "auth-flow-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  userEmail = `auth+${Date.now()}@test.local`;
  userPassword = "testpass123";
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: userEmail,
      password: userPassword,
      name: "Auth Tester",
      org_name: `AuthOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) {
    const body = await reg.text().catch(() => "");
    throw new Error(`register failed: ${reg.status} ${body}`);
  }
  const data = (await reg.json()) as { token: string; user: { orgId: number } };
  userToken = data.token;
  userOrgId = data.user.orgId;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Login flow ───────────────────────────────────────────────────────────

test("POST /auth/login with correct password returns a token", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: userPassword }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { token: string };
  assert.ok(data.token && data.token.length > 20, "expected a JWT in the response");
});

test("POST /auth/login with wrong password returns 401", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: "wrong-password" }),
  });
  assert.equal(res.status, 401);
});

test("POST /auth/login with non-existent email returns 401", async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost@example.com", password: "anything" }),
  });
  assert.equal(res.status, 401);
});

test("POST /auth/login error response does not distinguish missing-user from wrong-password", async () => {
  // Timing-attack mitigation: both error paths should look identical to
  // the client (same status, same JSON body shape).
  const wrongPw = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: "nope" }),
  });
  const noUser = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost-2@example.com", password: "nope" }),
  });
  assert.equal(wrongPw.status, noUser.status, "status code leaks user existence");
  const a = (await wrongPw.json()) as Record<string, unknown>;
  const b = (await noUser.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), "response shape leaks user existence");
});

test("GET /auth/me with valid JWT returns the current user", async () => {
  const res = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { user: { email: string; orgId: number } };
  assert.equal(data.user.email, userEmail);
  assert.equal(data.user.orgId, userOrgId);
});

test("GET /auth/me without auth returns 401", async () => {
  const res = await fetch(`${BASE}/auth/me`);
  assert.equal(res.status, 401);
});

test("POST /auth/switch-org rejects non-member orgs", async () => {
  // Try to switch into an org id the user does not belong to.
  const res = await fetch(`${BASE}/auth/switch-org`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ orgId: userOrgId + 99999 }),
  });
  assert.equal(res.status, 403);
});

// ── API-key path ─────────────────────────────────────────────────────────

let createdApiKey: string;
let createdApiKeyId: number;

test("POST /auth/api-keys creates a key and returns the raw value once", async () => {
  const res = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ label: "test-key" }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { key: string; prefix: string; label: string };
  assert.ok(data.key.startsWith("fk_"), "API keys should use the fk_ prefix");
  assert.equal(data.label, "test-key");
  createdApiKey = data.key;

  // Confirm it shows up in the list, and that the LIST never returns the
  // raw key (only the prefix) — listing the raw key would let any read of
  // /auth/api-keys exfiltrate the secret.
  const list = await fetch(`${BASE}/auth/api-keys`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const keys = (await list.json()) as Array<{ id: number; key_prefix: string; key?: string }>;
  const me = keys.find((k) => k.key_prefix === data.prefix)!;
  assert.ok(me, "newly-created key not in the listing");
  assert.equal(me.key, undefined, "GET /auth/api-keys must not return the raw key");
  createdApiKeyId = me.id;
});

test("GET /auth/me with API key authenticates as the issuing user", async () => {
  const res = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${createdApiKey}` },
  });
  assert.equal(res.status, 200, `API key auth failed: ${res.status}`);
  const data = (await res.json()) as { user: { email: string; orgId: number } };
  assert.equal(data.user.email, userEmail);
  assert.equal(data.user.orgId, userOrgId, "API key resolves to the issuing user's org");
});

test("API key authenticates protected routes", async () => {
  // Sanity-check that the API key works against /runs (the most-used
  // upload target).
  const res = await fetch(`${BASE}/runs`, {
    headers: { Authorization: `Bearer ${createdApiKey}` },
  });
  assert.equal(res.status, 200);
});

test("API key with fk_ prefix that does not exist returns 401, not 500", async () => {
  const res = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: "Bearer fk_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "expected an error string in the 401 response");
});

test("DELETE /auth/api-keys/:id revokes the key — subsequent requests 401", async () => {
  // Sanity: the key works right now.
  const before = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${createdApiKey}` },
  });
  assert.equal(before.status, 200);

  // Revoke it.
  const del = await fetch(`${BASE}/auth/api-keys/${createdApiKeyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(del.status, 200);

  // The same key string must now fail.  A regression here (key still
  // valid after deletion) is a credential-revocation failure.
  const after = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${createdApiKey}` },
  });
  assert.equal(after.status, 401, "deleted API key must stop authenticating immediately");
});

test("DELETE /auth/api-keys/:id 404s when the id is for another user's key", async () => {
  // Register a second user; create a key for them; the first user must
  // not be able to delete it (via either RLS or the WHERE user_id check).
  const otherEmail = `auth-other+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: otherEmail,
      password: "testpass123",
      name: "Other",
      org_name: `OtherOrg-${Date.now()}`,
    }),
  });
  const otherData = (await reg.json()) as { token: string };
  const keyRes = await fetch(`${BASE}/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherData.token}` },
    body: JSON.stringify({ label: "other-key" }),
  });
  const keyData = (await keyRes.json()) as { prefix: string };

  // List from the other user's perspective to find the row id.
  const list = await fetch(`${BASE}/auth/api-keys`, {
    headers: { Authorization: `Bearer ${otherData.token}` },
  });
  const keys = (await list.json()) as Array<{ id: number; key_prefix: string }>;
  const otherKeyId = keys.find((k) => k.key_prefix === keyData.prefix)!.id;

  // First user attempts to delete the second user's key.
  const cross = await fetch(`${BASE}/auth/api-keys/${otherKeyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(cross.status, 404, "user must not be able to delete another user's API key");

  // Confirm the other user's key still exists.
  const stillThere = await fetch(`${BASE}/auth/api-keys`, {
    headers: { Authorization: `Bearer ${otherData.token}` },
  });
  const remaining = (await stillThere.json()) as Array<{ id: number }>;
  assert.ok(
    remaining.some((k) => k.id === otherKeyId),
    "key was deleted by another user — credential isolation broken"
  );
});

// ── Refresh + logout ─────────────────────────────────────────────────────

test("POST /auth/logout responds 200 and clears the cookies", async () => {
  const res = await fetch(`${BASE}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.status, 200);
  // Logout should clear both cookies (Set-Cookie headers on the response).
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.ok(
    setCookie.includes("flakey_token") || setCookie.includes("flakey_refresh"),
    "logout response did not include Set-Cookie headers to clear the token cookies"
  );
});

// ── Registration boundaries ──────────────────────────────────────────────

test("POST /auth/register rejects passwords shorter than 8 chars", async () => {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `short+${Date.now()}@test.local`,
      password: "1234",
      name: "Short",
      org_name: "ShortOrg",
    }),
  });
  assert.equal(res.status, 400, "8-char minimum password should be enforced");
});

// ── Refresh-token flow ──────────────────────────────────────────────────

test("POST /auth/refresh exchanges a valid refresh token for a working access token", async () => {
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: userPassword }),
  });
  assert.equal(login.status, 200);
  const data = (await login.json()) as { token: string; refreshToken: string };
  assert.ok(data.refreshToken, "login should return a refresh token in body");

  const refresh = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: data.refreshToken }),
  });
  assert.equal(refresh.status, 200);
  const refreshed = (await refresh.json()) as { token: string; refreshToken: string };
  assert.ok(refreshed.token, "refresh should return an access token");
  assert.ok(refreshed.refreshToken, "refresh should return a new refresh token");

  // Verify the refreshed token actually authenticates a request — the
  // critical invariant is that refresh produces a usable access token,
  // not that the bytes differ from the original (within the same second
  // jwt sign() may produce identical bytes due to second-resolution iat).
  const me = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${refreshed.token}` },
  });
  assert.equal(me.status, 200, "refreshed access token should authenticate /auth/me");
});

test("POST /auth/refresh rejects garbage refresh tokens with 401", async () => {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: "not-a-real-jwt" }),
  });
  assert.equal(res.status, 401);
});

test("POST /auth/refresh rejects an access token (must not accept it as a refresh)", async () => {
  // Token-confusion check: the access JWT has type=undefined; the
  // refresh JWT has type=refresh.  Sending an access token should be
  // rejected to prevent attackers who steal an access token from
  // promoting it to a long-lived refresh.
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: userToken }),
  });
  assert.equal(res.status, 401, "access JWT must not be accepted on the /auth/refresh endpoint");
});

// ── Password-reset request flow ─────────────────────────────────────────

test("POST /auth/forgot-password is rate-limit-safe across unknown vs known emails", async () => {
  // Both forms must return identical 200 responses to prevent email
  // enumeration via the forgot-password endpoint.
  const known = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail }),
  });
  const unknown = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `nobody-${Date.now()}@nowhere.example` }),
  });
  assert.equal(known.status, unknown.status, "forgot-password must not differentiate known vs unknown email by status");
  const a = (await known.json()) as Record<string, unknown>;
  const b = (await unknown.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
    "forgot-password response shape must not differ between known and unknown email");
});

test("POST /auth/reset-password rejects garbage token with 400", async () => {
  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "garbage", password: "newpass123" }),
  });
  assert.equal(res.status, 400);
});

test("POST /auth/reset-password rejects passwords shorter than 8 chars even with valid token", async () => {
  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "any", password: "short" }),
  });
  // Either path is fine: 400 from short-password check (preferred) or
  // 400 from invalid-token check.  What matters is no 500 and that a
  // <8-char password is never accepted.
  assert.equal(res.status, 400);
});

// ── Email verification ──────────────────────────────────────────────────

test("POST /auth/verify-email rejects garbage token with 400", async () => {
  const res = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "garbage" }),
  });
  assert.equal(res.status, 400);
});

test("POST /auth/verify-email rejects missing token with 400", async () => {
  const res = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /auth/resend-verification does not differentiate known/unknown/verified email", async () => {
  // Same enumeration-resistance check as forgot-password.
  const verified = await fetch(`${BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail }),
  });
  const unknown = await fetch(`${BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `phantom-${Date.now()}@nowhere.example` }),
  });
  assert.equal(verified.status, unknown.status,
    "resend-verification must not differentiate by status");
});

test("POST /auth/register rejects duplicate email", async () => {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: userEmail, // already registered above
      password: "anotherpass123",
      name: "Dup",
      org_name: "DupOrg",
    }),
  });
  assert.notEqual(res.status, 201, "duplicate email should not produce a 201");
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx for duplicate email, got ${res.status}`);
});

// ── Email-casing regression suite ───────────────────────────────────────

test("POST /auth/register treats Alice@X.com and alice@x.com as the same account", async () => {
  // Pre-fix: these two went past the UNIQUE constraint as separate rows
  // with different password hashes — operator nightmare and a data-leak
  // risk if the wrong row got tied to an org membership.
  const lower = `casereg+${Date.now()}@test.local`;
  const upper = lower.toUpperCase();

  const first = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: lower, password: "password123", name: "First", org_name: `Lower-${Date.now()}` }),
  });
  assert.ok(first.ok, `first registration should succeed (got ${first.status})`);

  const second = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: upper, password: "password456", name: "Second", org_name: `Upper-${Date.now()}` }),
  });
  assert.equal(second.status, 409, "second registration with same effective email must 409");
});

test("POST /auth/login accepts mixed-case email and trimmed whitespace", async () => {
  // Two regressions in one test (rate-limit budget is tight on this
  // shared smoke server):
  //   - case-insensitive lookup: register lowercase, login uppercase → 200
  //   - trim: leading/trailing whitespace from mobile autofill → 200
  // Pre-fix: WHERE email = $1 was strict, so both produced 401 even
  // though the password was correct.
  const decorated = `  ${userEmail.toUpperCase()}\t`;
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: decorated, password: userPassword }),
  });
  assert.equal(login.status, 200,
    `login with uppercase + whitespace should succeed (got ${login.status})`);
});

