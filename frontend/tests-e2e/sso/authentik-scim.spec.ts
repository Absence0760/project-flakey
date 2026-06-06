import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * SCIM provisioning e2e proof (Phase 14 prototype) — drives a real SCIM 2.0
 * outbound sync from Authentik into a mock target, with no online signup.
 *
 * Why Authentik (not Keycloak): it acts as a SCIM *provider* out of the box —
 * it pushes users/groups to a target endpoint. Flakey doesn't have an inbound
 * /scim/v2 endpoint yet (proposal slice 3), so infra/scim-target/server.mjs
 * stands in and records every push at /_captured. This test asserts the loop:
 *
 *   1. Wire a SCIM provider (→ scim-target) + app + role group in Authentik.
 *   2. Create a user → assert it is PROVISIONED onto the target (+ the group).
 *   3. Deactivate the user → assert it is DEPROVISIONED (active:false) — the
 *      GovRAMP "revoke access immediately" control.
 *
 * Determinism notes:
 *   - Each test uses a UNIQUELY-named user so there's no stale Authentik→target
 *     connection from a prior run (Authentik persists remote-id mappings).
 *   - A provider PATCH is the "sync now" trigger (the background interval is
 *     too slow/variable to wait on). We poll the target for the real push —
 *     waiting on the actual signal, not a fixed sleep.
 *
 * Prereq: `pnpm idp:scim:up` (Authentik + scim-target). Part of `pnpm test:e2e:sso`.
 */

const AUTHENTIK = process.env.AUTHENTIK_URL ?? "http://localhost:9002";
const AK_TOKEN = process.env.AUTHENTIK_TOKEN ?? "flakey-authentik-dev-token";
const SCIM_TARGET = process.env.SCIM_TARGET_URL ?? "http://localhost:8082";
const API = `${AUTHENTIK}/api/v3`;
// The provider's target URL is the in-Docker-network address (Authentik pushes
// from its container); the test reads captures from the host-mapped port.
const SCIM_TARGET_INTERNAL = process.env.SCIM_TARGET_INTERNAL ?? "http://scim-target:8082/scim/v2";
const SCIM_TOKEN = process.env.SCIM_TOKEN ?? "flakey-scim-dev-token";

const akHeaders = { Authorization: `Bearer ${AK_TOKEN}`, "Content-Type": "application/json" };

let providerPk: number;
const createdUserPks: number[] = [];
const createdGroupPks: string[] = [];

async function akGet(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}${path}`, { headers: akHeaders });
  expect(res.ok(), `GET ${path} -> ${res.status()}`).toBeTruthy();
  return res.json();
}
async function akPost(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.post(`${API}${path}`, { headers: akHeaders, data: body });
  expect(res.ok(), `POST ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}
async function akPatch(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.patch(`${API}${path}`, { headers: akHeaders, data: body });
  expect(res.ok(), `PATCH ${path} -> ${res.status()}`).toBeTruthy();
  return res.json();
}

/** Force an immediate full sync by re-saving the provider. */
async function forceSync(request: APIRequestContext) {
  await akPatch(request, `/providers/scim/${providerPk}/`, { dry_run: false });
}

async function captured(request: APIRequestContext) {
  const res = await request.get(`${SCIM_TARGET}/_captured`);
  return res.json() as Promise<{ users: any[]; groups: any[]; log: any[] }>;
}

test.beforeAll(async ({ request }) => {
  // Idempotently wire the SCIM provider + application + role group. Self-
  // contained so the test runs after a bare `pnpm idp:scim:up` with no setup.
  const mappings = await akGet(request, "/propertymappings/provider/scim/");
  const userMap = mappings.results.find((m: any) => m.managed === "goauthentik.io/providers/scim/user").pk;
  const groupMap = mappings.results.find((m: any) => m.managed === "goauthentik.io/providers/scim/group").pk;

  const existingProv = (await akGet(request, "/providers/scim/?name=flakey-scim")).results[0];
  providerPk = existingProv
    ? existingProv.pk
    : (await akPost(request, "/providers/scim/", {
        name: "flakey-scim",
        url: SCIM_TARGET_INTERNAL,
        token: SCIM_TOKEN,
        property_mappings: [userMap],
        property_mappings_group: [groupMap],
        exclude_users_service_account: true,
      })).pk;

  const app = (await akGet(request, "/core/applications/?slug=flakey")).results[0];
  if (!app) {
    await akPost(request, "/core/applications/", { name: "Flakey", slug: "flakey", backchannel_providers: [providerPk] });
  }
});

test.afterAll(async ({ request }) => {
  // Best-effort cleanup so repeated local runs don't pile up fixtures.
  for (const pk of createdUserPks) await request.delete(`${API}/core/users/${pk}/`, { headers: akHeaders }).catch(() => {});
  for (const pk of createdGroupPks) await request.delete(`${API}/core/groups/${pk}/`, { headers: akHeaders }).catch(() => {});
});

test("a new IdP user is provisioned to the SCIM target (user + role group)", async ({ request }) => {
  // Unique group per run: a fresh role group has no stale Authentik→target
  // connection, so it always provisions cleanly regardless of prior state.
  const groupName = `flakey-role-${Date.now()}`;
  const group = await akPost(request, "/core/groups/", { name: groupName });
  createdGroupPks.push(group.pk);

  const username = `e2e-prov-${Date.now()}@example.com`;
  const user = await akPost(request, "/core/users/", {
    username, name: "E2E Provision", email: username, is_active: true, groups: [group.pk],
  });
  createdUserPks.push(user.pk);

  await forceSync(request);

  await expect
    .poll(async () => (await captured(request)).users.some((u) => u.userName === username),
      { timeout: 45_000, intervals: [1_000] })
    .toBe(true);
  // The role group (which Flakey's SCIM endpoint would map to an org role)
  // provisions alongside the user.
  await expect
    .poll(async () => (await captured(request)).groups.some((g) => g.displayName === groupName),
      { timeout: 45_000, intervals: [1_000] })
    .toBe(true);

  const pushed = (await captured(request)).users.find((u) => u.userName === username);
  expect(pushed, "user provisioned to target").toBeTruthy();
  expect(pushed.active, "provisioned active").not.toBe(false);
});

test("deactivating an IdP user deprovisions them on the target (active:false)", async ({ request }) => {
  const username = `e2e-deact-${Date.now()}@example.com`;
  const user = await akPost(request, "/core/users/", {
    username, name: "E2E Deactivate", email: username, is_active: true,
  });
  createdUserPks.push(user.pk);

  await forceSync(request);
  await expect
    .poll(async () => (await captured(request)).users.some((u) => u.userName === username),
      { timeout: 45_000, intervals: [1_000] })
    .toBe(true);

  // Revoke access at the IdP — the SCIM deprovision the GovRAMP control needs.
  await akPatch(request, `/core/users/${user.pk}/`, { is_active: false });
  await forceSync(request);

  await expect
    .poll(async () => {
      const u = (await captured(request)).users.find((x) => x.userName === username);
      return u?.active === false;
    }, { timeout: 45_000, intervals: [1_000] })
    .toBe(true);
});
