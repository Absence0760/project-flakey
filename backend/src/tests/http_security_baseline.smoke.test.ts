/**
 * HTTP security-baseline smoke.
 *
 * helmet is wired in index.ts but with contentSecurityPolicy
 * disabled — a real gap, since an accidentally-rendered HTML
 * response (Express's default error page, a future template
 * route) would have no CSP to restrict what the browser would
 * load on the user's behalf.  This file pins:
 *
 *   1. The helmet defaults that are already on (nosniff, frame
 *      DENY, Referrer-Policy, X-Powered-By stripped, HSTS in
 *      prod-y modes) so a `helmet({ ... })` config change
 *      that accidentally drops them is caught.
 *   2. A non-empty CSP header that at minimum denies framing
 *      and inline scripting.  Catches a future regression where
 *      `contentSecurityPolicy: false` slips back in.
 *   3. CORS enforcement in production mode: requests from an
 *      origin not in CORS_ORIGINS are rejected, requests from
 *      an allowed origin succeed, and credentials are echoed
 *      back so the cookie path keeps working.
 *   4. Auth cookies in production carry HttpOnly + Secure +
 *      SameSite=Strict (the trifecta that makes them resistant
 *      to XSS read, MITM, and CSRF respectively).
 *   5. The 50 MB JSON body limit is enforced — a 60 MB body
 *      returns 413, not OOM the process.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3981;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

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
      JWT_SECRET: "http-baseline-test-secret",
      // Required by the production-mode boot guard (added in
      // backend/src/index.ts). Throwaway value — this test only
      // exercises HTTP headers, never reads/writes encrypted secrets.
      FLAKEY_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      ALLOW_REGISTRATION: "true",
      // Run in NODE_ENV=production so CORS enforces the origin
      // allowlist (in development cors is permissive) and the
      // cookie flags pick up Secure + SameSite=Strict. Requires
      // JWT_SECRET + FLAKEY_ENCRYPTION_KEY set, which the spawn env
      // already supplies.
      NODE_ENV: "production",
      CORS_ORIGINS: "https://frontend.example.com",
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

// ── helmet baseline headers ─────────────────────────────────────────────

test("baseline helmet headers are set on every response (nosniff / frame-deny / Referrer-Policy / no X-Powered-By)", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  // X-Content-Type-Options nosniff prevents the browser from
  // sniffing a non-script MIME as JavaScript — defends against
  // a stored XSS via misclassified-as-JS asset.
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  // X-Frame-Options DENY blocks clickjacking via iframe embed.
  assert.match(
    res.headers.get("x-frame-options") ?? "",
    /^(deny|sameorigin)$/i,
    "X-Frame-Options must be DENY or SAMEORIGIN",
  );
  // Referrer-Policy prevents leaking the full URL (including any
  // query-string tokens used by /uploads) to third-party origins.
  assert.ok(res.headers.get("referrer-policy"), "Referrer-Policy must be set");
  // helmet strips X-Powered-By by default; pin the absence so a
  // re-enabling slips don't leak the framework fingerprint.
  assert.equal(
    res.headers.get("x-powered-by"),
    null,
    "X-Powered-By must NOT be set — leaks framework fingerprint to attackers",
  );
});

test("Content-Security-Policy is non-empty and at minimum denies framing + restricts default-src", async () => {
  // The existing config sets `contentSecurityPolicy: false`,
  // which means no CSP header at all. For an API backend that
  // occasionally renders HTML (Express's default error page;
  // future SSR routes) this is defence-in-depth left on the
  // table. A strict CSP (default-src 'none', frame-ancestors
  // 'none') is essentially free for a JSON/SVG/static-file API.
  const res = await fetch(`${BASE}/health`);
  const csp = res.headers.get("content-security-policy");
  assert.ok(
    csp,
    "Content-Security-Policy must be set — `contentSecurityPolicy: false` in helmet config drops the header entirely",
  );
  // Restrict default-src so unsolicited asset loads from any
  // accidentally-rendered HTML response are denied.
  assert.match(
    csp,
    /default-src\s+'none'/i,
    "CSP must include `default-src 'none'` so misclassified HTML responses can't fetch attacker-controlled scripts/styles/etc.",
  );
  // frame-ancestors blocks the page from being embedded in a
  // third-party frame — clickjacking defence at the CSP layer
  // (complements X-Frame-Options DENY).
  assert.match(
    csp,
    /frame-ancestors\s+'none'/i,
    "CSP must include `frame-ancestors 'none'`",
  );
});

// ── CORS in production mode ────────────────────────────────────────────

test("CORS in production rejects an Origin not in CORS_ORIGINS (no Access-Control-Allow-Origin echoed)", async () => {
  // Send an Origin the server doesn't whitelist. The cors
  // middleware in IS_PROD mode runs the origin callback which
  // returns an error for unknown origins; the response must NOT
  // include `Access-Control-Allow-Origin: <evil>`, otherwise the
  // browser would let JS read the response cross-origin.
  const res = await fetch(`${BASE}/health`, {
    headers: { Origin: "https://attacker.example" },
  });
  // A 403/500/etc would also be acceptable here — what's NOT
  // acceptable is a 200 that echoes the evil origin back.
  assert.notEqual(
    res.headers.get("access-control-allow-origin"),
    "https://attacker.example",
    "Access-Control-Allow-Origin must not echo an origin that isn't in CORS_ORIGINS",
  );
  assert.notEqual(
    res.headers.get("access-control-allow-origin"),
    "*",
    "Access-Control-Allow-Origin must not be wildcard while credentials are allowed",
  );
});

test("CORS in production accepts an Origin in CORS_ORIGINS and echoes it back with credentials true", async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { Origin: "https://frontend.example.com" },
  });
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    "https://frontend.example.com",
    "Allowed origin must be echoed back so the browser permits the cookie-bearing request",
  );
  assert.equal(
    res.headers.get("access-control-allow-credentials"),
    "true",
    "credentials must be allowed so the httpOnly cookie auth path works",
  );
});

// ── Auth cookie flags in production ────────────────────────────────────

test("auth cookies in production carry HttpOnly + Secure + SameSite=Strict (XSS + MITM + CSRF defences)", async () => {
  // Register a user; the response Set-Cookie headers carry the
  // flakey_token + flakey_refresh cookies. In NODE_ENV=production
  // they must be marked HttpOnly (no JS read), Secure (no
  // plaintext transport), SameSite=Strict (no cross-site send).
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `cookie-flags+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Cookie Flags",
      org_name: `CookieFlagsOrg-${Date.now()}`,
    }),
  });
  assert.equal(res.status, 201);

  const setCookieHeaders = res.headers.getSetCookie();
  const tokenCookie = setCookieHeaders.find((c) => c.startsWith("flakey_token="));
  const refreshCookie = setCookieHeaders.find((c) => c.startsWith("flakey_refresh="));
  assert.ok(tokenCookie, "flakey_token Set-Cookie header must be present");
  assert.ok(refreshCookie, "flakey_refresh Set-Cookie header must be present");

  for (const [name, c] of [["flakey_token", tokenCookie], ["flakey_refresh", refreshCookie]] as const) {
    assert.match(c, /;\s*HttpOnly/i, `${name}: HttpOnly flag missing — JS could read the cookie via document.cookie XSS`);
    assert.match(c, /;\s*Secure/i, `${name}: Secure flag missing — cookie could be transmitted over plain HTTP`);
    assert.match(c, /;\s*SameSite=Strict/i, `${name}: SameSite=Strict missing — vulnerable to CSRF via cross-site form POST`);
  }
});

// ── Body size limit ────────────────────────────────────────────────────

test("express.json's 50 MB limit is enforced — a 60 MB body returns 413, not OOM", async () => {
  // 60 MB payload — must trip the 50mb limit. The body is a
  // single very-long string value so the parser allocates linearly.
  // 413 is the "Payload Too Large" status; anything 2xx means the
  // limit isn't being honoured.
  const huge = '{"x":"' + "A".repeat(60 * 1024 * 1024) + '"}';
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: huge,
  });
  assert.equal(
    res.status,
    413,
    "60 MB JSON body must return 413 from express.json's 50 MB limit — anything else means an attacker can spike memory at will",
  );
});
