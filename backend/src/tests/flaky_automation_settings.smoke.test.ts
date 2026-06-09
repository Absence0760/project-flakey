/**
 * Flaky-automation org-config smoke tests (PATCH/GET /orgs/:id/settings).
 *
 * Migration 060 added auto_quarantine_enabled / auto_quarantine_min_flips /
 * auto_quarantine_min_runs / flaky_alert_threshold to organizations and the
 * org-settings route now reads + writes them. This backstops:
 *   - an admin/owner can PATCH the four fields and GET reflects them,
 *   - flaky_alert_threshold accepts null (off) and clamps out-of-range to 0..100,
 *   - min_flips / min_runs clamp to [1, 1000] and reject non-numeric input,
 *   - auto_quarantine_enabled is a strict boolean,
 *   - a viewer is 403 on write.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3909;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let orgId: number;
let viewerToken: string;

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
      JWT_SECRET: "flaky-automation-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const stamp = Date.now();
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `flakyauto+${stamp}@test.local`, password: "testpass123",
      name: "FlakyAuto", org_name: `FlakyAutoOrg-${stamp}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const body = (await reg.json()) as { token: string; user: { orgId: number } };
  token = body.token;
  orgId = body.user.orgId;

  // Stand up a viewer in the same org via the real invite-accept flow.
  const viewerReg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `flakyauto-viewer+${stamp}@test.local`, password: "testpass123",
      name: "FlakyAutoViewer", org_name: `FlakyAutoViewerOrg-${stamp}`,
    }),
  });
  if (!viewerReg.ok) throw new Error(`viewer register failed: ${viewerReg.status}`);
  const viewer = (await viewerReg.json()) as { token: string; user: { email: string } };

  const invite = await fetch(`${BASE}/orgs/${orgId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email: viewer.user.email, role: "viewer" }),
  });
  if (!invite.ok) throw new Error(`invite failed: ${invite.status}`);
  const inviteData = (await invite.json()) as { invite_token: string };

  const accept = await fetch(`${BASE}/orgs/invites/${inviteData.invite_token}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewer.token}` },
  });
  if (!accept.ok) throw new Error(`accept failed: ${accept.status}`);
  const acceptData = (await accept.json()) as { token: string; user: { orgRole: string } };
  assert.equal(acceptData.user.orgRole, "viewer");
  viewerToken = acceptData.token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

type Settings = {
  auto_quarantine_enabled: boolean;
  auto_quarantine_min_flips: number;
  auto_quarantine_min_runs: number;
  flaky_alert_threshold: number | null;
};

function getSettings(authToken = token) {
  return fetch(`${BASE}/orgs/${orgId}/settings`, { headers: { Authorization: `Bearer ${authToken}` } });
}
function patchSettings(body: unknown, authToken = token) {
  return fetch(`${BASE}/orgs/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
}

test("admin can PATCH the flaky-automation fields and GET reflects them", async () => {
  const res = await patchSettings({
    auto_quarantine_enabled: true,
    auto_quarantine_min_flips: 6,
    auto_quarantine_min_runs: 20,
    flaky_alert_threshold: 25,
  });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const data = (await (await getSettings()).json()) as Settings;
  assert.equal(data.auto_quarantine_enabled, true);
  assert.equal(data.auto_quarantine_min_flips, 6);
  assert.equal(data.auto_quarantine_min_runs, 20);
  assert.equal(Number(data.flaky_alert_threshold), 25);
});

test("GET settings exposes all four flaky-automation fields", async () => {
  const data = (await (await getSettings()).json()) as Settings;
  assert.ok("auto_quarantine_enabled" in data);
  assert.ok("auto_quarantine_min_flips" in data);
  assert.ok("auto_quarantine_min_runs" in data);
  assert.ok("flaky_alert_threshold" in data);
});

test("flaky_alert_threshold accepts null to turn the alert off", async () => {
  const res = await patchSettings({ flaky_alert_threshold: null });
  assert.equal(res.status, 200, `expected 200; got ${res.status}`);
  const data = (await (await getSettings()).json()) as Settings;
  assert.equal(data.flaky_alert_threshold, null);
});

test("flaky_alert_threshold clamps out-of-range values into 0..100", async () => {
  await patchSettings({ flaky_alert_threshold: 250 });
  let data = (await (await getSettings()).json()) as Settings;
  assert.equal(Number(data.flaky_alert_threshold), 100, "above-range clamps to 100");

  await patchSettings({ flaky_alert_threshold: -10 });
  data = (await (await getSettings()).json()) as Settings;
  assert.equal(Number(data.flaky_alert_threshold), 0, "below-range clamps to 0");
});

test("flaky_alert_threshold rejects a non-numeric value with 400 (not 500)", async () => {
  const res = await patchSettings({ flaky_alert_threshold: "abc" });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("auto_quarantine min_flips / min_runs clamp to [1, 1000]", async () => {
  await patchSettings({ auto_quarantine_min_flips: 0, auto_quarantine_min_runs: 999999 });
  const data = (await (await getSettings()).json()) as Settings;
  assert.equal(data.auto_quarantine_min_flips, 1, "min_flips floors at 1");
  assert.equal(data.auto_quarantine_min_runs, 1000, "min_runs caps at 1000");
});

test("auto_quarantine min_flips rejects a non-integer with 400 (not 500)", async () => {
  const res = await patchSettings({ auto_quarantine_min_flips: "lots" });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("auto_quarantine_enabled rejects a non-boolean with 400", async () => {
  const res = await patchSettings({ auto_quarantine_enabled: "yes" });
  assert.equal(res.status, 400, `expected 400; got ${res.status}`);
});

test("a viewer is 403 when writing flaky-automation settings", async () => {
  const res = await patchSettings({ auto_quarantine_enabled: false }, viewerToken);
  assert.equal(res.status, 403, `expected 403 for viewer; got ${res.status}`);
});
