/**
 * Auth token attack surface — JWT manipulation + flow-token replay.
 *
 * auth_flow.smoke.test.ts pins the happy paths (login, /me, refresh,
 * API keys, password-reset request) but doesn't poke at the token
 * itself or the consumed-state of flow tokens. The gaps this file
 * fills:
 *
 *   1. JWT with `alg: none` (the canonical lib-of-the-week attack)
 *      is rejected — relying on jsonwebtoken's default settings is
 *      the right answer, but if someone ever passes `algorithms`
 *      with "none" in it the test catches the regression.
 *   2. A JWT whose payload is tampered (orgId rewritten to a
 *      foreign org) is rejected because the signature no longer
 *      matches. Pins the assumption that the orgId claim is
 *      signature-bound.
 *   3. Expired JWT → 401. The verifier's exp check must be active.
 *   4. JWT signed with a different secret → 401 (no cross-key
 *      acceptance).
 *   5. Reset-password tokens are one-time use AND honour the
 *      DB-stored expiry. Replay of a consumed token returns 400,
 *      and a token whose expiry has been moved into the past also
 *      returns 400.
 *   6. Verify-email tokens same: one-time use + expiry-honouring.
 *   7. Org-invite tokens: replay (already accepted) → 404,
 *      expiry-honouring → 404.
 *
 * The DB-poke pattern (using a pg.Client as the `flakey` superuser
 * to UPDATE expires_at into the past) is the standard test-side
 * shortcut for proving expiry semantics without waiting wall-clock
 * minutes for them to trip.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import pg from "pg";

const PORT = 3987;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = "auth-tokens-test-secret";

let server: ChildProcess;
let dbAdmin: pg.Client;

interface UserCtx {
  email: string;
  userId: number;
  token: string;
  orgId: number;
}

let primary: UserCtx;

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

async function registerUser(label: string): Promise<UserCtx> {
  const email = `auth-tok+${label}+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: `AuthTok-${label}`,
      org_name: `AuthTokOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`register ${label} failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as {
    token: string;
    user: { id: number; orgId: number };
  };
  return { email, userId: data.user.id, orgId: data.user.orgId, token: data.token };
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
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
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Connect as the `flakey` superuser so the test can poke expires_at
  // columns directly. The server's own connection still uses
  // flakey_app (RLS active); only this test harness uses admin
  // creds, which is the standard test-side shortcut.
  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  primary = await registerUser("primary");
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── JWT-level rejection cases ───────────────────────────────────────────

test("JWT with alg:none is rejected — verifier does not accept unsigned tokens", async () => {
  // Hand-craft a "none-algorithm" JWT. jsonwebtoken's verify rejects
  // these by default, but historically this has been the most-cited
  // library footgun (CVE-2015-9235 style). Pin it.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      id: primary.userId,
      email: primary.email,
      orgId: primary.orgId,
      role: "admin",
      orgRole: "owner",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const forged = `${header}.${payload}.`;

  const res = await fetch(`${BASE}/auth/me`, { headers: authHeader(forged) });
  assert.equal(res.status, 401, "alg:none JWT must not authenticate");
});

test("JWT with a tampered payload (orgId rewritten) is rejected — signature is org-bound", async () => {
  // Decode the legitimate token, swap orgId for a non-existent
  // 999999, re-encode the body but keep the original signature.
  // The verifier recomputes HMAC over header.body and rejects.
  const [h, b, s] = primary.token.split(".");
  const body = JSON.parse(Buffer.from(b, "base64url").toString());
  body.orgId = 999999;
  const tampered = `${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${s}`;

  const res = await fetch(`${BASE}/auth/me`, { headers: authHeader(tampered) });
  assert.equal(res.status, 401, "tampered orgId claim must be rejected; the claim must be signature-bound");
});

test("JWT with a tampered signature is rejected", async () => {
  // Garble the last segment. The verifier's HMAC compare fails.
  const [h, b] = primary.token.split(".");
  const forged = `${h}.${b}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

  const res = await fetch(`${BASE}/auth/me`, { headers: authHeader(forged) });
  assert.equal(res.status, 401, "tampered signature must be rejected");
});

test("JWT signed with a different secret is rejected — no key-swap acceptance", async () => {
  const wrongKey = jwt.sign(
    {
      id: primary.userId,
      email: primary.email,
      orgId: primary.orgId,
      role: "admin",
      orgRole: "owner",
    },
    "totally-unrelated-attacker-secret",
    { expiresIn: "1h" },
  );

  const res = await fetch(`${BASE}/auth/me`, { headers: authHeader(wrongKey) });
  assert.equal(res.status, 401, "JWT signed under a foreign secret must not authenticate");
});

test("Expired JWT (exp in the past) is rejected", async () => {
  // Sign a token with the correct secret but an `exp` already in
  // the past. The verifier's exp check must trip; otherwise stolen
  // tokens never expire.
  const expired = jwt.sign(
    {
      id: primary.userId,
      email: primary.email,
      orgId: primary.orgId,
      role: "admin",
      orgRole: "owner",
    },
    JWT_SECRET,
    { expiresIn: -60 },
  );

  const res = await fetch(`${BASE}/auth/me`, { headers: authHeader(expired) });
  assert.equal(res.status, 401, "expired JWT must be rejected — exp check must be active");
});

test("Bearer header without a token (just 'Bearer ') is rejected", async () => {
  const res = await fetch(`${BASE}/auth/me`, { headers: { Authorization: "Bearer " } });
  assert.equal(res.status, 401, "empty bearer token must 401, not 500");
});

// ── Reset-password token: one-time use + expiry ─────────────────────────

async function issueResetToken(email: string): Promise<string> {
  // Trigger forgot-password to create the token in the DB, then
  // read it back via the admin client. The route emits the token
  // by email only; reading the DB is the only way the test can
  // observe the value.
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.ok(res.ok, "/auth/forgot-password should return ok for a known user");
  const row = await dbAdmin.query(
    "SELECT password_reset_token FROM users WHERE email = $1",
    [email],
  );
  const t = row.rows[0]?.password_reset_token as string | null;
  if (!t) throw new Error("forgot-password did not write a reset token to the DB");
  return t;
}

test("Reset-password token: replay of a consumed token returns 400 (one-time use)", async () => {
  const token = await issueResetToken(primary.email);

  const first = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "newpass-1234" }),
  });
  assert.equal(first.status, 200, "first use of reset token should succeed");

  const replay = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "another-pass-9999" }),
  });
  assert.equal(replay.status, 400, "second use of reset token must 400 — token must be NULLed on consumption");
});

test("Reset-password token: expired token returns 400 even though it's still in the row", async () => {
  // Issue a fresh token, then move its expiry into the past via
  // the admin client. The route's `password_reset_expires_at >
  // NOW()` filter must reject it.
  const token = await issueResetToken(primary.email);
  await dbAdmin.query(
    "UPDATE users SET password_reset_expires_at = NOW() - INTERVAL '1 hour' WHERE email = $1",
    [primary.email],
  );

  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "still-not-allowed" }),
  });
  assert.equal(res.status, 400, "expired reset token must be rejected — the expires_at check must be active");
});

// ── Verify-email token: one-time use + expiry ───────────────────────────

async function issueVerifyEmailToken(email: string): Promise<string> {
  // /auth/resend-verification only writes a new token if the user
  // exists AND email_verified is false. Force the user back into a
  // pristine unverified state so we can re-issue a token, then read it.
  // Clearing email_verification_last_sent_at is required: registration
  // stamps it, and a non-null recent value would trip the per-email resend
  // cooldown and suppress the new token (the cooldown itself is covered in
  // register_verification_gate.smoke.test.ts).
  await dbAdmin.query(
    "UPDATE users SET email_verified = false, email_verification_token = NULL, email_verification_expires_at = NULL, email_verification_last_sent_at = NULL WHERE email = $1",
    [email],
  );
  const res = await fetch(`${BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.ok(res.ok, "/auth/resend-verification should return ok");
  const row = await dbAdmin.query(
    "SELECT email_verification_token FROM users WHERE email = $1",
    [email],
  );
  const t = row.rows[0]?.email_verification_token as string | null;
  if (!t) throw new Error("resend-verification did not write a token to the DB");
  return t;
}

test("Verify-email token: replay of a consumed token returns 400 (one-time use)", async () => {
  const token = await issueVerifyEmailToken(primary.email);

  const first = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(first.status, 200, "first use of verify-email token should succeed");

  const replay = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(replay.status, 400, "second use of verify-email token must 400 — token must be NULLed on consumption");
});

test("Verify-email token: expired token returns 400", async () => {
  const token = await issueVerifyEmailToken(primary.email);
  await dbAdmin.query(
    "UPDATE users SET email_verification_expires_at = NOW() - INTERVAL '1 hour' WHERE email = $1",
    [primary.email],
  );

  const res = await fetch(`${BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 400, "expired verify-email token must be rejected");
});

// ── Org-invite token: one-time use + expiry + wrong-recipient ──────────

async function issueInvite(inviterToken: string, orgId: number, inviteeEmail: string): Promise<string> {
  const res = await fetch(`${BASE}/orgs/${orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(inviterToken) },
    body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`invite create failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { invite_token: string };
  return data.invite_token;
}

async function registerInvitee(inviteeEmail: string): Promise<string> {
  // Register a second user (their own org) so they have a session
  // to accept the invite with.
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: inviteeEmail,
      password: "testpass123",
      name: "Invitee",
      org_name: `InviteeOwn-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`invitee register failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

test("Org-invite token: accepted invite cannot be re-accepted (one-time use via accepted_at)", async () => {
  // Register the invitee FIRST so resolveOrg gives them their own
  // personal org; otherwise resolveOrg auto-accepts the invite
  // during registration (auth.ts:30-42) and the explicit accept
  // route never gets to flip accepted_at — the contract under
  // test here is the explicit-accept replay guard.
  const inviteeEmail = `auth-tok-invitee+${Date.now()}@test.local`;
  const inviteeAuth = await registerInvitee(inviteeEmail);
  const inviteToken = await issueInvite(primary.token, primary.orgId, inviteeEmail);

  const first = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: authHeader(inviteeAuth),
  });
  assert.equal(first.status, 200, "first invite accept should succeed");

  const replay = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: authHeader(inviteeAuth),
  });
  assert.equal(
    replay.status,
    404,
    "accepted invite must not be acceptable again — the `accepted_at IS NULL` filter must reject the replay",
  );
});

test("Org-invite token: expired invite returns 404", async () => {
  const inviteeEmail = `auth-tok-invitee-exp+${Date.now()}@test.local`;
  const inviteeAuth = await registerInvitee(inviteeEmail);
  const inviteToken = await issueInvite(primary.token, primary.orgId, inviteeEmail);

  // Move expiry into the past via the admin client.
  await dbAdmin.query(
    "UPDATE org_invites SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = $1",
    [inviteToken],
  );

  const res = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: authHeader(inviteeAuth),
  });
  assert.equal(res.status, 404, "expired invite must 404 — `expires_at > NOW()` filter must trip");
});

test("Org-invite token: accepting as the wrong user returns 403 (recipient binding)", async () => {
  const inviteeEmail = `auth-tok-wrong-recipient+${Date.now()}@test.local`;
  const inviteToken = await issueInvite(primary.token, primary.orgId, inviteeEmail);
  // Don't register inviteeEmail. Use a DIFFERENT user (primary)
  // to attempt acceptance — emails won't match.
  const res = await fetch(`${BASE}/orgs/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: authHeader(primary.token),
  });
  assert.equal(
    res.status,
    403,
    "invite must be accepted only by the named recipient; mismatch must 403, not 200",
  );
});
