/**
 * Org settings (PATCH /orgs/:id/settings) input-validation smoke tests.
 *
 * Backstops the validation added to retention_days and git_provider: bad
 * input must produce a clean 400, never a 500 from a downstream int-cast or
 * CHECK-constraint violation, and a positive integer / known provider must
 * still round-trip. retention_days null explicitly disables the policy.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { GIT_PROVIDERS } from "../routes/orgs.js";

const PORT = 3902;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let orgId: number;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
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
      JWT_SECRET: "org-settings-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `orgset+${Date.now()}@test.local`, password: "testpass123",
      name: "OrgSet", org_name: `OrgSetOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const body = (await reg.json()) as { token: string; user: { orgId: number } };
  token = body.token;
  orgId = body.user.orgId;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

function getSettings() {
  return fetch(`${BASE}/orgs/${orgId}/settings`, { headers: { Authorization: `Bearer ${token}` } });
}
function patchSettings(body: unknown) {
  return fetch(`${BASE}/orgs/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// ── retention_days ──────────────────────────────────────────────────────

test("PATCH settings accepts a positive integer retention_days", async () => {
  const res = await patchSettings({ retention_days: 30 });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const get = await getSettings();
  const data = (await get.json()) as { retention_days: number };
  assert.equal(data.retention_days, 30);
});

test("PATCH settings rejects a non-numeric retention_days with 400 (not 500)", async () => {
  // Regression: "abc" → Number(...) = NaN → a 500 on the integer cast.
  const res = await patchSettings({ retention_days: "abc" });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("PATCH settings rejects retention_days = 0", async () => {
  // 0 used to be silently stored and then treated as "disabled" by the sweep.
  const res = await patchSettings({ retention_days: 0 });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("PATCH settings rejects a negative retention_days", async () => {
  const res = await patchSettings({ retention_days: -5 });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("PATCH settings rejects a fractional retention_days", async () => {
  const res = await patchSettings({ retention_days: 5.5 });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("PATCH settings rejecting bad input does not mutate the stored value", async () => {
  // The valid 30 from the first test must survive a rejected write.
  await patchSettings({ retention_days: "nope" });
  const data = (await (await getSettings()).json()) as { retention_days: number };
  assert.equal(data.retention_days, 30, "a 400'd PATCH must leave retention_days untouched");
});

test("PATCH settings accepts null retention_days to disable the policy", async () => {
  const res = await patchSettings({ retention_days: null });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const data = (await (await getSettings()).json()) as { retention_days: number | null };
  assert.equal(data.retention_days, null);
});

// ── git_provider ────────────────────────────────────────────────────────

test("PATCH settings accepts a known git_provider", async () => {
  const res = await patchSettings({ git_provider: "github" });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const data = (await (await getSettings()).json()) as { git_provider: string };
  assert.equal(data.git_provider, "github");
});

test("PATCH settings rejects an unknown git_provider with 400 (not 500)", async () => {
  // Regression: "gitea" violated the organizations_git_provider_check CHECK
  // and surfaced as a 500 instead of a clean validation error.
  const res = await patchSettings({ git_provider: "gitea" });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("PATCH settings accepts empty git_provider to clear it", async () => {
  const res = await patchSettings({ git_provider: "" });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const data = (await (await getSettings()).json()) as { git_provider: string | null };
  assert.equal(data.git_provider, null);
});

test("every GIT_PROVIDERS value is accepted by the DB CHECK constraint (no drift)", async () => {
  // Lockstep guard: the route's allow-list and organizations_git_provider_check
  // (migration 044) are hand-synced. If a value is added to GIT_PROVIDERS that
  // the CHECK doesn't allow, this PATCH 500s on the constraint instead of 200.
  for (const provider of GIT_PROVIDERS) {
    const res = await patchSettings({ git_provider: provider });
    assert.equal(res.status, 200, `git_provider="${provider}" must be accepted by the CHECK; got ${res.status}`);
    const data = (await (await getSettings()).json()) as { git_provider: string };
    assert.equal(data.git_provider, provider);
  }
});
