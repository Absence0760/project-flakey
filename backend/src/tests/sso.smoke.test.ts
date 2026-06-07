/**
 * SSO (OIDC) smoke tests — full app, real DB.
 *
 * Backstops the slice-1 invariants:
 *   - kill switch: with FLAKEY_SSO_ENABLED unset, every SSO route 404s.
 *   - fail closed: /start 404s for an org with no enabled config.
 *   - config round-trips and NEVER returns the client secret.
 *   - /start runs a real Authorization-Code + PKCE redirect against a mock IdP
 *     (state + nonce + S256 challenge + client_id present on the authorize URL).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http from "node:http";

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow — deterministic test fixture

// ── A tiny mock OIDC IdP: just enough discovery for /start to build a URL. ──
let idp: http.Server;
let idpUrl: string;

async function startMockIdp(): Promise<void> {
  idp = http.createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/openid-configuration")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: idpUrl,
        authorization_endpoint: `${idpUrl}/authorize`,
        token_endpoint: `${idpUrl}/token`,
        jwks_uri: `${idpUrl}/jwks`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const addr = idp.address() as { port: number };
  idpUrl = `http://127.0.0.1:${addr.port}`;
}

function waitForHealth(base: string, maxMs = 10000): Promise<void> {
  return (async () => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Backend did not become healthy in time");
  })();
}

function spawnApp(port: number, env: Record<string, string>): ChildProcess {
  const p = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "sso-smoke-secret",
      FLAKEY_ENCRYPTION_KEY: ENC_KEY,
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FRONTEND_URL: "http://localhost:7778",
      PUBLIC_API_URL: `http://localhost:${port}`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", (d) => process.stderr.write(d));
  return p;
}

const PORT = 3991;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let token: string;
let orgSlug: string;

before(async () => {
  await startMockIdp();
  server = spawnApp(PORT, { FLAKEY_SSO_ENABLED: "true" });
  await waitForHealth(BASE);

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `sso+${Date.now()}@test.local`, password: "testpass123", name: "SSO Admin" }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;

  const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const orgs = ((await me.json()) as { orgs: { slug: string }[] }).orgs;
  orgSlug = orgs[0].slug; // fresh user is owner of their personal org
});

after(async () => {
  if (server && !server.killed) { server.kill("SIGTERM"); await once(server, "exit").catch(() => {}); }
  await new Promise<void>((r) => idp.close(() => r()));
});

const authed = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } });

test("fail closed: /start 404s for an org with no enabled SSO config", async () => {
  const res = await fetch(`${BASE}/auth/sso/${orgSlug}/start`, { redirect: "manual" });
  assert.equal(res.status, 404);
});

test("admin can PUT an OIDC config and GET it back WITHOUT the client secret", async () => {
  const put = await authed("/sso/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      oidcIssuer: idpUrl,
      oidcClientId: "flakey-web",
      oidcClientSecret: "super-secret-value",
      jitProvisioning: true,
      allowedDomains: ["test.local"],
      defaultRole: "viewer",
      roleClaim: "flakey_roles",
      roleMap: { "flakey-admin": "admin", "flakey-viewer": "viewer" },
    }),
  });
  assert.equal(put.status, 200, "PUT /sso/config should succeed");

  const get = await authed("/sso/config");
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.configured, true);
  assert.equal(body.enabled, true);
  assert.equal(body.hasClientSecret, true, "must report a secret is stored");
  // The secret must NEVER be returned in any form.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("super-secret-value"), "client secret must not leak in the config response");
  assert.equal(body.oidcClientSecret, undefined);
});

test("PUT rejects a role_map value that isn't a real org role", async () => {
  const res = await authed("/sso/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, oidcIssuer: idpUrl, oidcClientId: "x", roleMap: { "g": "superadmin" } }),
  });
  assert.equal(res.status, 400);
});

test("status reports SSO enabled once configured", async () => {
  const res = await fetch(`${BASE}/auth/sso/${orgSlug}/status`);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.protocol, "oidc");
});

test("/start runs a real PKCE authorize redirect against the IdP", async () => {
  const res = await fetch(`${BASE}/auth/sso/${orgSlug}/start`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith(`${idpUrl}/authorize`), `expected redirect to IdP authorize, got ${loc}`);
  const u = new URL(loc);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "flakey-web");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("code_challenge"), "must carry a PKCE challenge");
  assert.ok(u.searchParams.get("state"), "must carry CSRF state");
  assert.ok(u.searchParams.get("nonce"), "must carry a nonce");
  // The transaction cookie binds state/nonce/verifier server-side.
  assert.ok((res.headers.get("set-cookie") ?? "").includes("flakey_sso_tx"), "must set the tx cookie");
});

test("kill switch: with FLAKEY_SSO_ENABLED unset, SSO routes 404", async () => {
  const port = 3992;
  const off = spawnApp(port, {}); // no FLAKEY_SSO_ENABLED
  try {
    await waitForHealth(`http://localhost:${port}`);
    const start = await fetch(`http://localhost:${port}/auth/sso/whatever/start`, { redirect: "manual" });
    assert.equal(start.status, 404);
    const cfg = await fetch(`http://localhost:${port}/sso/config`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(cfg.status, 404);
  } finally {
    off.kill("SIGTERM");
    await once(off, "exit").catch(() => {});
  }
});
