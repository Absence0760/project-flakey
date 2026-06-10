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
 *   FLAKEY_SSO_ENABLED=true pnpm dev:backend   # backend on :3000 with SSO live
 * Then:  cd frontend && pnpm test:e2e:sso:app
 *
 * The webServer block boots only the FRONTEND (vite on :7778) — the same shape
 * as the main playwright.config.ts. The backend is started separately (above
 * locally, by the sso-e2e CI job in CI) with FLAKEY_SSO_ENABLED so the SSO
 * routes are live; that keeps a pre-started backend from being double-launched
 * (port 3000 conflict) when the config boots its own server.
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
    // Frontend only (`pnpm run dev` = vite on :7778). The backend is pre-started
    // with FLAKEY_SSO_ENABLED — see the header note. cwd is resolved relative to
    // THIS config's dir (frontend/tests-e2e/sso/), so "../.." = frontend/ — two
    // levels up (the main config is one level shallower, hence ".." there).
    command: "pnpm run dev",
    cwd: "../..",
    url: "http://localhost:7778",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PUBLIC_API_URL: "http://localhost:3000",
      VITE_API_URL: "http://localhost:3000",
      KEYCLOAK_URL,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
