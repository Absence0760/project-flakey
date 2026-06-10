/**
 * HTTP smoke test for the audit-export config routes + GET /audit/verify.
 *
 * Pins the security-relevant wiring:
 *   - the auth token is NEVER returned (only auth_token_set), on create or list;
 *   - destination validation (bad URL, s3 without bucket) → 400;
 *   - the instance kill-switch: with FLAKEY_AUDIT_EXPORT_ENABLED unset, the
 *     whole /audit/export surface 404s (verified with a second, flag-off app);
 *   - GET /audit/verify returns a structured integrity result.
 *
 * The viewer-403 branch shares denyExportAccess with the already-tested GET
 * /audit admin gate, so it isn't re-exercised here.
 *
 * Spawns the real app (like audit_coverage.smoke.test.ts). Needs the local DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 3983;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token = "";

async function waitForHealth(base: string, maxMs = 12000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

function spawnApp(port: number, extraEnv: Record<string, string>): ChildProcess {
  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "audit-export-routes-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
      WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return proc;
}

before(async () => {
  server = spawnApp(PORT, { FLAKEY_AUDIT_EXPORT_ENABLED: "true" });
  await waitForHealth(BASE);
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `audit-export+${Date.now()}@test.local`,
      password: "testpass123",
      name: "ExportOwner",
      org_name: `ExportOrg-${Date.now()}`,
    }),
  });
  assert.ok(reg.ok, `register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  if (server) {
    server.kill();
  }
});

const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

test("POST /audit/export creates a destination and never returns the token", async () => {
  const res = await fetch(`${BASE}/audit/export`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      destination: "http",
      endpoint_url: "https://siem.example.com/collector",
      auth_header_name: "Authorization",
      auth_token: "Bearer super-secret-token",
      enabled: true,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.destination, "http");
  assert.equal(body.enabled, true);
  assert.equal(body.auth_token_set, true, "indicates a token is set");
  assert.equal(body.auth_token, undefined, "raw token must never be returned");
  assert.equal(body.auth_token_encrypted, undefined, "encrypted token must never be returned");
  // Whole-body string check: the secret must appear nowhere.
  assert.ok(!JSON.stringify(body).includes("super-secret-token"));
});

test("GET /audit/export lists destinations with the token redacted", async () => {
  const res = await fetch(`${BASE}/audit/export`, { headers: auth() });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list) && list.length >= 1);
  for (const c of list) {
    assert.equal(c.auth_token, undefined);
    assert.equal(c.auth_token_encrypted, undefined);
    assert.ok(!JSON.stringify(c).includes("super-secret-token"));
  }
});

test("POST /audit/export rejects a malformed URL and s3 without a bucket", async () => {
  const badUrl = await fetch(`${BASE}/audit/export`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ destination: "http", endpoint_url: "not-a-url" }),
  });
  assert.equal(badUrl.status, 400);

  const noBucket = await fetch(`${BASE}/audit/export`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ destination: "s3" }),
  });
  assert.equal(noBucket.status, 400);
});

test("DELETE /audit/export/:id removes a destination", async () => {
  const created = await (
    await fetch(`${BASE}/audit/export`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ destination: "s3", s3_bucket: "my-audit-bucket", s3_prefix: "logs" }),
    })
  ).json();
  const del = await fetch(`${BASE}/audit/export/${created.id}`, { method: "DELETE", headers: auth() });
  assert.equal(del.status, 204);
  const after = await (await fetch(`${BASE}/audit/export`, { headers: auth() })).json();
  assert.ok(!after.some((c: { id: number }) => c.id === created.id), "deleted config is gone");
});

async function createHttp(extra: Record<string, unknown> = {}): Promise<{ id: number; auth_token_set: boolean; last_exported_id: string }> {
  const res = await fetch(`${BASE}/audit/export`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ destination: "http", endpoint_url: "https://siem.example.com/c", ...extra }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

test("PATCH /audit/export/:id rejects nulling a required field (no broken-but-validated config)", async () => {
  const cfg = await createHttp();
  const res = await fetch(`${BASE}/audit/export/${cfg.id}`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ endpoint_url: null }),
  });
  assert.equal(res.status, 400, "explicit null on a required field must 400, not persist");
  // The config is unchanged (still has its URL → delivery wouldn't be bricked).
  const list = await (await fetch(`${BASE}/audit/export`, { headers: auth() })).json();
  const still = list.find((c: { id: number; endpoint_url: string | null }) => c.id === cfg.id);
  assert.ok(still && still.endpoint_url, "endpoint_url must be intact after the rejected PATCH");
});

test("PATCH /audit/export/:id token: omit leaves, null clears, string rotates", async () => {
  const cfg = await createHttp({ auth_header_name: "Authorization", auth_token: "Bearer secret-1" });
  assert.equal(cfg.auth_token_set, true);

  const patch = async (b: Record<string, unknown>) =>
    (await fetch(`${BASE}/audit/export/${cfg.id}`, { method: "PATCH", headers: auth(), body: JSON.stringify(b) })).json();

  let r = await patch({ enabled: true }); // auth_token omitted → leave
  assert.equal(r.auth_token_set, true, "omitting auth_token leaves it set");
  r = await patch({ auth_token: null }); // explicit null → clear
  assert.equal(r.auth_token_set, false, "null auth_token clears it");
  r = await patch({ auth_token: "Bearer secret-2" }); // string → rotate
  assert.equal(r.auth_token_set, true, "a new token string sets it again");
  // The raw token is never returned at any point.
  assert.ok(!JSON.stringify(r).includes("secret-2"));
});

test("POST default cursor seeds from current max (not 0); from_beginning seeds 0", async () => {
  // The org already has audit rows (each export-config create above is audited),
  // so a default-cursor destination must start past 0 — otherwise enabling a
  // SIEM destination would replay the entire existing audit log.
  const dflt = await createHttp();
  assert.notEqual(String(dflt.last_exported_id), "0", "default cursor seeds from the current max audit id");

  const scratch = await createHttp({ from_beginning: true });
  assert.equal(String(scratch.last_exported_id), "0", "from_beginning streams the full history");
});

test("GET /audit/verify returns a structured integrity result", async () => {
  const res = await fetch(`${BASE}/audit/verify`, { headers: auth() });
  assert.equal(res.status, 200);
  const v = await res.json();
  assert.equal(typeof v.ok, "boolean");
  assert.equal(typeof v.totalRows, "number");
  assert.equal(typeof v.hashedRows, "number");
  assert.ok("firstBrokenId" in v);
  // A freshly registered org's own audit rows form a clean chain.
  assert.equal(v.ok, true, v.reason ?? "fresh org chain should verify");
});

test("kill-switch: with the flag off, the /audit/export surface 404s", async () => {
  const offPort = 3984;
  const off = spawnApp(offPort, {}); // no FLAKEY_AUDIT_EXPORT_ENABLED
  try {
    await waitForHealth(`http://localhost:${offPort}`);
    const reg = await fetch(`http://localhost:${offPort}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `audit-export-off+${Date.now()}@test.local`,
        password: "testpass123",
        name: "OffOwner",
        org_name: `OffOrg-${Date.now()}`,
      }),
    });
    const offToken = ((await reg.json()) as { token: string }).token;
    const res = await fetch(`http://localhost:${offPort}/audit/export`, {
      headers: { Authorization: `Bearer ${offToken}` },
    });
    assert.equal(res.status, 404, "export surface must not exist when the flag is off");
    // But the audit log + verify still work (they're not flag-gated).
    const verify = await fetch(`http://localhost:${offPort}/audit/verify`, {
      headers: { Authorization: `Bearer ${offToken}` },
    });
    assert.equal(verify.status, 200);
  } finally {
    off.kill();
  }
});
