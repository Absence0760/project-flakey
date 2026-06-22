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
// A second org used to prove cross-org isolation: org B must never see, patch,
// delete, or test org A's export config.
let tokenB = "";

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

  const regB = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `audit-export-b+${Date.now()}@test.local`,
      password: "testpass123",
      name: "OtherOwner",
      org_name: `ExportOrgB-${Date.now()}`,
    }),
  });
  assert.ok(regB.ok, `register B failed: ${regB.status}`);
  tokenB = ((await regB.json()) as { token: string }).token;
});

after(async () => {
  if (server) {
    server.kill();
  }
});

const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const authB = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` });

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

test("cross-org isolation: org B cannot see, patch, delete, or test org A's config", async () => {
  // Org A owns a config carrying a distinctive endpoint + secret. enabled:true so
  // the closing "unchanged" check is meaningful (org B's PATCH would flip it off).
  // The endpoint carries an opaque canary in its path (not a bare hostname — a
  // hostname substring check reads to CodeQL as an incomplete URL sanitizer) so
  // the leak assertion below keys off a unique marker that can only originate
  // from org A's stored endpoint_url.
  const orgAEndpointCanary = "org-a-endpoint-canary-7f3a2b";
  const a = await createHttp({
    enabled: true,
    endpoint_url: `https://org-a-only.example.com/secret-collector/${orgAEndpointCanary}`,
    auth_header_name: "Authorization",
    auth_token: "Bearer org-a-private-token",
  });

  // 1. Org B's list never contains org A's row (RLS scopes the SELECT to org B).
  const bList = await (await fetch(`${BASE}/audit/export`, { headers: authB() })).json();
  assert.ok(Array.isArray(bList));
  assert.ok(!bList.some((c: { id: number }) => c.id === a.id), "org B must not see org A's config");
  // …and org A's endpoint/secret leak nowhere into org B's response body.
  assert.ok(!JSON.stringify(bList).includes(orgAEndpointCanary), "org A's endpoint must not leak into org B's response");
  assert.ok(!JSON.stringify(bList).includes("org-a-private-token"));

  // 2. GET-by-side-effect: org B's PATCH targets a real id it doesn't own → 404
  // (not 403), so the existence of org A's config isn't even confirmed.
  const bPatch = await fetch(`${BASE}/audit/export/${a.id}`, {
    method: "PATCH",
    headers: authB(),
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(bPatch.status, 404, "org B patching org A's config must 404");

  // 3. Org B's DELETE of org A's id → 404, and org A's config survives.
  const bDel = await fetch(`${BASE}/audit/export/${a.id}`, { method: "DELETE", headers: authB() });
  assert.equal(bDel.status, 404, "org B deleting org A's config must 404");

  // 4. Org B's /test of org A's id → 404 (can't trigger a delivery on A's behalf).
  const bTest = await fetch(`${BASE}/audit/export/${a.id}/test`, { method: "POST", headers: authB() });
  assert.equal(bTest.status, 404, "org B testing org A's config must 404");

  // Org A's config is untouched after all of org B's attempts.
  const aList = await (await fetch(`${BASE}/audit/export`, { headers: auth() })).json();
  const still = aList.find((c: { id: number; enabled: boolean }) => c.id === a.id);
  assert.ok(still, "org A's config must still exist");
  assert.equal(still.enabled, true, "org A's config must be unchanged (org B's PATCH didn't land)");
});

test("POST /audit/export/:id/test on a healthy id returns {ok:true} (probe delivered)", async () => {
  // Stand up a throwaway receiver that 200s, so the synthetic probe succeeds and
  // the endpoint reports ok:true without advancing the cursor.
  const { createServer } = await import("node:http");
  const receiver = createServer((_q, s) => {
    s.statusCode = 200;
    s.end("ok");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const addr = receiver.address() as { port: number };
  try {
    const cfg = await createHttp({ endpoint_url: `http://127.0.0.1:${addr.port}/collect` });
    const before = cfg.last_exported_id;
    const res = await fetch(`${BASE}/audit/export/${cfg.id}/test`, { method: "POST", headers: auth() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, true, "a reachable 200 receiver yields ok:true");
    assert.equal(body.error, undefined, "no error on success");
    // The probe must NOT advance the export cursor (it's a connectivity test).
    const list = await (await fetch(`${BASE}/audit/export`, { headers: auth() })).json();
    const after = list.find((c: { id: number; last_exported_id: string }) => c.id === cfg.id);
    assert.equal(String(after.last_exported_id), String(before), "test must not advance the cursor");
  } finally {
    receiver.close();
  }
});

test("POST /audit/export/:id/test on an unreachable destination returns a sanitized error (no URL/token leak)", async () => {
  // Reserve a port, then close it so the connection is refused. WEBHOOK_ALLOW_
  // PRIVATE_TARGETS=true lets the loopback target past the SSRF gate, so we get a
  // genuine connection error rather than a blocked-target rejection.
  const { createServer } = await import("node:http");
  const tmp = createServer();
  await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
  const deadPort = (tmp.address() as { port: number }).port;
  await new Promise<void>((resolve) => tmp.close(() => resolve()));

  const secretToken = "Bearer unreachable-secret-token";
  const cfg = await createHttp({
    endpoint_url: `http://127.0.0.1:${deadPort}/collect`,
    auth_header_name: "Authorization",
    auth_token: secretToken,
  });
  const res = await fetch(`${BASE}/audit/export/${cfg.id}/test`, { method: "POST", headers: auth() });
  assert.equal(res.status, 200, "a failed probe is a 200 report, not a 500");
  const body = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, false, "an unreachable destination yields ok:false");
  assert.equal(typeof body.error, "string");
  // The error is sanitized: it names a connection problem, never the token,
  // and never the full endpoint URL/path.
  assert.ok(!JSON.stringify(body).includes(secretToken), "the auth token must not leak in the error");
  assert.ok(!JSON.stringify(body).includes("unreachable-secret-token"));
  assert.ok(!body.error!.includes("/collect"), "the endpoint path must not leak in the error");
  assert.match(body.error!, /connection error|timed out|delivery failed/i, "error is a sanitized category");
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

test("GET /audit/export/status reports enabled:true when the flag is on", async () => {
  const res = await fetch(`${BASE}/audit/export/status`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean };
  assert.equal(body.enabled, true);
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
    // The status probe stays reachable (200) and reports enabled:false — that's
    // how the Settings subnav hides the link without hitting the 404 surface.
    const status = await fetch(`http://localhost:${offPort}/audit/export/status`, {
      headers: { Authorization: `Bearer ${offToken}` },
    });
    assert.equal(status.status, 200, "status probe must not be flag-gated");
    assert.deepEqual(await status.json(), { enabled: false });
    // But the audit log + verify still work (they're not flag-gated).
    const verify = await fetch(`http://localhost:${offPort}/audit/verify`, {
      headers: { Authorization: `Bearer ${offToken}` },
    });
    assert.equal(verify.status, 200);
  } finally {
    off.kill();
  }
});
