import { defineConfig, devices } from "@playwright/test";

/**
 * Registration-gate e2e config — the PRODUCTION posture
 * (REQUIRE_EMAIL_VERIFICATION=true).
 *
 * The main playwright.config.ts runs the flag-OFF default (register mints a
 * session) and ignores this directory. This config runs registration-gate.spec.ts
 * against a backend started with the verification gate ON, so the browser-level
 * behaviour the smoke test can't reach (the "Check your email" panel, the
 * blocked-login UI, no token on register) is exercised end to end.
 *
 * Prereqs (the spec talks to a live, seeded backend + Mailpit):
 *   pnpm db:up                                   # Postgres + Mailpit
 *   cd backend && ./migrate.sh && npm run seed   # seeded users are email_verified
 *   REQUIRE_EMAIL_VERIFICATION=true ALLOW_REGISTRATION=true pnpm dev:backend
 * Then:  cd frontend && pnpm test:e2e:verify
 *
 * In CI the verify-required job in .github/workflows/tests.yml starts the
 * flag-on backend and runs this config.
 *
 * Shape mirrors playwright.sso-app.config.ts: the webServer block boots only
 * the FRONTEND (vite :7778); the backend is pre-started with the flag so a
 * port-3000 conflict can't double-launch it. globalSetup signs the seeded
 * admin in (verified, so login works under the gate) to mint invites.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /registration-gate\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single end-to-end flow; keep it serial and deterministic
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  // Reuse the seeded-admin sign-in (writes .auth/*.json consumed via
  // ADMIN_USER.storageStatePath). Path is relative to this config's dir.
  globalSetup: "../fixtures/auth.ts",
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
    // with REQUIRE_EMAIL_VERIFICATION=true. cwd is resolved relative to THIS
    // config's dir (frontend/tests-e2e/verify-required/), so "../.." = frontend/.
    command: "pnpm run dev",
    cwd: "../..",
    url: "http://localhost:7778",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      VITE_API_URL: "http://localhost:3000",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
