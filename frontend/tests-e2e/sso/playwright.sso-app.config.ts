import { defineConfig, devices } from "@playwright/test";

/**
 * App-facing OIDC e2e config (Phase 14, Slice 1).
 *
 * Unlike playwright.sso.config.ts (which drives Keycloak's endpoints directly
 * to prove the IdP contract), this drives the REAL Flakey app end to end:
 * login page → "Sign in with SSO" → backend /auth/sso/:slug/start → Keycloak
 * hosted login → /auth/sso/callback (token exchange + ID-token verification +
 * JIT provisioning) → /sso/complete handoff → dashboard.
 *
 * Prereqs (the spec talks to a live, seeded backend + Keycloak):
 *   pnpm idp:up                       # local Keycloak, realm `flakey`
 *   pnpm db:up && cd backend && ./migrate.sh && npm run seed
 * Then:  cd frontend && pnpm test:e2e:sso:app
 *
 * The webServer block boots the whole app (root `pnpm dev` = backend + frontend)
 * with FLAKEY_SSO_ENABLED so the SSO routes are live.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8081";

export default defineConfig({
  testDir: ".",
  testMatch: /keycloak-oidc-app\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1, // mutates a shared org's SSO config — must run serially
  reporter: "list",
  use: {
    baseURL: "http://localhost:7778",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-GB",
    timezoneId: "UTC",
  },
  webServer: {
    command: "pnpm run dev",
    cwd: "../..",
    url: "http://localhost:7778",
    reuseExistingServer: true,
    timeout: 90_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      FLAKEY_SSO_ENABLED: "true",
      PUBLIC_API_URL: "http://localhost:3000",
      FRONTEND_URL: "http://localhost:7778",
      VITE_API_URL: "http://localhost:3000",
      KEYCLOAK_URL,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
