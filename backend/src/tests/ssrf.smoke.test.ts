/**
 * SSRF defence on user-configurable URLs.
 *
 * The two surfaces where a tenant admin can configure a URL the
 * backend later dispatches to via fetch():
 *   - POST /webhooks            { url: "https://..." }
 *   - PATCH /jira/settings      { base_url: "https://..." }
 *
 * Both flow through validateWebhookUrl in routes/webhooks.ts. The gate
 * has two layers (see the JSDoc on that function for the full rationale):
 *
 *   - Always: scheme must be http or https. file://, javascript:,
 *     data:, etc. always blocked.
 *   - In production (or when WEBHOOK_ALLOW_PRIVATE_TARGETS=false is
 *     explicitly set): loopback / link-local / RFC1918 / CGNAT / IMDS /
 *     literal "localhost" and friends are blocked too.
 *
 * The backend is spawned with NODE_ENV=production so the private-target
 * gate is active. JWT_SECRET is set to a known value (production
 * refuses to start without one). CORS is loosened to localhost so the
 * test client itself isn't blocked.
 *
 * What's pinned:
 *   1. Scheme rejection (file://, javascript:, data:, gopher://, ftp://)
 *      → 400 with a "Unsupported URL scheme" message.
 *   2. Hostname rejection (every IMDS endpoint, every loopback form,
 *      every RFC1918 sample, IPv6 loopback + link-local + ULA, IPv4-
 *      mapped IPv6) → 400 with a "private / loopback / metadata" message.
 *   3. Public targets still accepted (sanity-check the gate isn't
 *      blanket-blocking everything).
 *   4. Jira PATCH /jira/settings runs the same gate on base_url —
 *      not just webhook POST.
 *   5. The opt-out env var WEBHOOK_ALLOW_PRIVATE_TARGETS=true loosens
 *      the gate when the operator explicitly enables it (covered by
 *      the parallel server spawn at the bottom).
 *
 * If a new tenant-configurable URL field is added (e.g. a self-hosted
 * GitHub/GitLab base host), wire it through validateWebhookUrl AND
 * extend this smoke to cover it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

// 3960/3961 are outside the 3971-3999 band the other smoke tests
// occupy — `npm test` runs each smoke file in parallel via
// `node --test`, so colliding on a bound port would crash every
// SSRF assertion as the spawn fails silently.
const PORT_BLOCK = 3960;
const PORT_ALLOW = 3961;
const BASE_BLOCK = `http://localhost:${PORT_BLOCK}`;
const BASE_ALLOW = `http://localhost:${PORT_ALLOW}`;
const JWT_SECRET = "ssrf-smoke-test-secret";

let serverBlock: ChildProcess;
let serverAllow: ChildProcess;
let adminTokenBlock: string;
let adminTokenAllow: string;

async function waitForHealth(base: string, maxMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Backend at ${base} did not become healthy in time`);
}

async function register(base: string, label: string): Promise<string> {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `ssrf+${label}+${Date.now()}@test.local`,
      password: "testpass123",
      name: `SSRF-${label}`,
      org_name: `SSRFOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`register ${label} failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { token: string }).token;
}

async function postWebhook(base: string, token: string, url: string): Promise<Response> {
  return fetch(`${base}/webhooks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: "ssrf-test", url, events: ["run.failed"], platform: "generic" }),
  });
}

async function patchJira(base: string, token: string, base_url: string): Promise<Response> {
  return fetch(`${base}/jira/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ base_url }),
  });
}

function spawnServer(port: number, env: Record<string, string>): ChildProcess {
  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET,
      ALLOW_REGISTRATION: "true",
      // CORS in prod requires CORS_ORIGINS; allow the loopback the
      // test client reaches in on.
      CORS_ORIGINS: `http://localhost:${port}`,
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return proc;
}

before(async () => {
  serverBlock = spawnServer(PORT_BLOCK, { NODE_ENV: "production" });
  serverAllow = spawnServer(PORT_ALLOW, {
    NODE_ENV: "production",
    WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
  });
  await Promise.all([waitForHealth(BASE_BLOCK), waitForHealth(BASE_ALLOW)]);
  adminTokenBlock = await register(BASE_BLOCK, "block");
  adminTokenAllow = await register(BASE_ALLOW, "allow");
});

after(async () => {
  for (const s of [serverBlock, serverAllow]) {
    if (s && !s.killed) {
      s.kill("SIGTERM");
      await once(s, "exit").catch(() => {});
    }
  }
});

// ── 1. Scheme rejection ─────────────────────────────────────────────────

const BAD_SCHEMES = [
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/plain,hello",
  "gopher://example.com/_GET%20/",
  "ftp://example.com/file",
];
for (const url of BAD_SCHEMES) {
  test(`POST /webhooks rejects non-http(s) scheme: ${url}`, async () => {
    const res = await postWebhook(BASE_BLOCK, adminTokenBlock, url);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Unsupported URL scheme|valid absolute URL/);
  });
}

// ── 2. Private / loopback / IMDS hostname rejection ─────────────────────

const BLOCKED_HOSTS = [
  // IPv4 loopback
  "http://127.0.0.1/",
  "http://127.0.0.1:9000/x",
  // IPv4 IMDS — AWS, Alibaba, Oracle Cloud all reachable here
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  // IPv4 link-local (any 169.254.x.x)
  "http://169.254.1.1/",
  // IPv4 private RFC1918
  "http://10.0.0.1/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  // IPv4 CGNAT
  "http://100.64.0.1/",
  // IPv4 multicast / reserved
  "http://224.0.0.1/",
  "http://0.0.0.0/",
  // Named literal aliases
  "http://localhost/",
  "http://localhost:3000/x",
  "http://metadata.google.internal/computeMetadata/v1/",
  // IPv6 loopback + link-local + ULA + v4-mapped
  "http://[::1]/",
  "http://[fe80::1]/",
  "http://[fc00::1]/",
  "http://[fd00::1]/",
  "http://[::ffff:127.0.0.1]/",
];
for (const url of BLOCKED_HOSTS) {
  test(`POST /webhooks (prod) rejects private/loopback/IMDS target: ${url}`, async () => {
    const res = await postWebhook(BASE_BLOCK, adminTokenBlock, url);
    assert.equal(res.status, 400, `expected 400 for ${url}, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /private \/ loopback \/ metadata/);
  });
}

// ── 3. Public hosts still accepted ──────────────────────────────────────

const PUBLIC_HOSTS = [
  "https://hooks.slack.com/services/T00/B00/xxx",
  "https://example.com/webhook",
  "http://1.1.1.1/",
  "https://[2001:4860:4860::8888]/",
];
for (const url of PUBLIC_HOSTS) {
  test(`POST /webhooks (prod) accepts public host: ${url}`, async () => {
    const res = await postWebhook(BASE_BLOCK, adminTokenBlock, url);
    assert.equal(res.status, 201, `expected 201 for ${url}, got ${res.status}: ${await res.text()}`);
  });
}

// ── 4. Jira PATCH runs the same gate ────────────────────────────────────

test("PATCH /jira/settings rejects an IMDS base_url", async () => {
  const res = await patchJira(BASE_BLOCK, adminTokenBlock, "http://169.254.169.254/");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /private \/ loopback \/ metadata/);
});

test("PATCH /jira/settings rejects a loopback base_url", async () => {
  const res = await patchJira(BASE_BLOCK, adminTokenBlock, "http://localhost:8080");
  assert.equal(res.status, 400);
});

test("PATCH /jira/settings accepts a real Atlassian host", async () => {
  const res = await patchJira(BASE_BLOCK, adminTokenBlock, "https://acme.atlassian.net");
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
});

// ── 5. Opt-out env var loosens the gate ─────────────────────────────────

test("WEBHOOK_ALLOW_PRIVATE_TARGETS=true lets a self-hosted op point webhooks at localhost", async () => {
  const res = await postWebhook(BASE_ALLOW, adminTokenAllow, "http://127.0.0.1:9000/hook");
  assert.equal(res.status, 201, `expected 201 with opt-out env, got ${res.status}: ${await res.text()}`);
});

test("WEBHOOK_ALLOW_PRIVATE_TARGETS=true still blocks non-http(s) schemes (scheme gate is unconditional)", async () => {
  const res = await postWebhook(BASE_ALLOW, adminTokenAllow, "file:///etc/passwd");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Unsupported URL scheme/);
});
