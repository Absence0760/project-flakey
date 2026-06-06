import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the SSO / Keycloak e2e proof (Phase 14 prototype).
 *
 * Deliberately separate from the main tests-e2e/playwright.config.ts:
 *   - No `globalSetup` — the main config's fixtures/auth.ts signs seeded
 *     users into the Flakey app, which needs the backend + seeded Postgres.
 *     The SSO proof only needs Keycloak, so it skips that entirely.
 *   - No `webServer` — there's no Flakey SSO integration to serve yet; the
 *     spec drives Keycloak's own login UI + OIDC endpoints directly.
 *
 * Prereq: a local Keycloak with the seeded `flakey` realm:
 *     pnpm idp:up        # from the repo root
 *
 * Run:  cd frontend && pnpm test:e2e:sso
 *
 * When real SSO lands, the app-facing SSO specs move under the MAIN config
 * (they need the app up) with an SSO storage-state setup; this Keycloak-only
 * config stays as the IdP-contract proof.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8081";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: KEYCLOAK_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-GB",
    timezoneId: "UTC",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
