import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * App-facing OIDC login e2e (Phase 14, Slice 1).
 *
 * Proves the full Flakey OIDC flow against the bundled Keycloak — the piece the
 * smoke tests (mock IdP) and the IdP-contract spec (Keycloak endpoints only)
 * don't cover together: a real browser going login → SSO → IdP → callback
 * (token exchange + ID-token verification + JIT provisioning) → session handoff
 * → dashboard.
 *
 * See playwright.sso-app.config.ts for prereqs (idp:up + seeded backend).
 */
const API = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
const ISSUER = `${KEYCLOAK_URL}/realms/flakey`;

// Seeded primary admin (backend seed) — used only to configure the org's SSO.
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "admin";
// Seeded Keycloak realm user (infra/keycloak/flakey-realm.json).
const SSO_USER = "sso.admin@example.com";
const SSO_PASSWORD = "ssopassword";

let orgSlug: string;

test.beforeAll(async () => {
  const api = await pwRequest.newContext({ baseURL: API });
  // 1. Sign in as the seeded admin to get a session.
  const login = await api.post("/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok(), `admin login (${login.status()}) — is the DB seeded?`).toBeTruthy();
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}` };

  // 2. Point this org's SSO at the local Keycloak realm.
  const put = await api.put("/sso/config", {
    headers: auth,
    data: {
      protocol: "oidc",
      enabled: true,
      oidcIssuer: ISSUER,
      oidcClientId: "flakey-web",
      oidcClientSecret: "flakey-dev-secret",
      jitProvisioning: true,
      roleClaim: "flakey_roles",
      roleMap: { "flakey-admin": "admin", "flakey-viewer": "viewer" },
    },
  });
  expect(put.ok(), `sso config PUT (${put.status()})`).toBeTruthy();

  // 3. Resolve the org slug to drive the SSO entry on the login page.
  const me = await api.get("/auth/me", { headers: auth });
  const { orgs } = await me.json();
  orgSlug = orgs[0].slug;
  await api.dispose();
});

test("a Keycloak user signs in through the Flakey app and lands authenticated", async ({ page }) => {
  // Start at the login page, choose SSO, enter the org identifier.
  await page.goto("/login");
  await page.click('[data-test="sso-entry"]');
  await page.fill('input[autocomplete="organization"]', orgSlug);
  await page.click('[data-test="sso-continue"]');

  // Backend /start redirects to Keycloak's hosted login form.
  await expect(page.locator("#kc-form-login")).toBeVisible();
  await page.fill("#username", SSO_USER);
  await page.fill("#password", SSO_PASSWORD);
  await page.click("#kc-login");

  // callback → /sso/complete handoff → dashboard. Assert we end up
  // authenticated in the app (not bounced back to /login with an error).
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  expect(page.url()).not.toContain("sso_error");
  // The SPA populated its auth model from the handoff.
  const token = await page.evaluate(() => localStorage.getItem("bt_token"));
  expect(token, "SSO session token stored after handoff").toBeTruthy();
});

test("bad IdP credentials never mint a Flakey session", async ({ page }) => {
  await page.goto("/login");
  await page.click('[data-test="sso-entry"]');
  await page.fill('input[autocomplete="organization"]', orgSlug);
  await page.click('[data-test="sso-continue"]');

  await expect(page.locator("#kc-form-login")).toBeVisible();
  await page.fill("#username", SSO_USER);
  await page.fill("#password", "wrong-password");
  await page.click("#kc-login");

  // Stays on Keycloak with an inline error — no callback, no Flakey session.
  await expect(page.locator("#input-error, .kc-feedback-text, .alert-error")).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem("bt_token"));
  expect(token, "no session token on failed IdP auth").toBeFalsy();
});
