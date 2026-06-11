import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config for the Flakey dashboard (frontend/).
 *
 * Prereq: backend API + seeded Postgres up. From the repo root:
 *   pnpm db:up
 *   cd backend && ./migrate.sh && npm run seed && npm run dev
 *
 * The frontend dev server is auto-started by the webServer block below.
 *
 * Why `vite dev` instead of `vite build && vite preview`:
 *   adapter-static + `fallback: "index.html"` in svelte.config.js
 *   produces a SPA shell for unmatched routes. `vite preview` doesn't
 *   serve the fallback for client-side-routed deep links (e.g.
 *   /runs/<id>) — production papers over this with a CloudFront
 *   viewer-request rewrite, so for headless e2e the dev server is
 *   the right server. The trade-off (HMR + slower first paint)
 *   doesn't matter for these specs.
 *
 * Local dev: `cd frontend && pnpm test:e2e` (auto-boots dev server).
 * Or `pnpm test:e2e:ui` for the UI runner.
 *
 * The fixtures/auth.ts globalSetup signs each seeded user in once via
 * the UI and saves their storage state to .auth/<user>.json. Spec
 * files attach the storage state via test.use({ storageState: ... }).
 * .auth/ is gitignored.
 */
export default defineConfig({
  testDir: ".",
  // Don't recurse into .auth/ or fixtures/ from the testDir glob. The sso/
  // suite is excluded too: it has its own configs (playwright.sso*.config.ts)
  // and hard-requires the opt-in IdP stack (Keycloak :8081, Authentik :9002,
  // SCIM target :8082) plus FLAKEY_SSO_ENABLED — none of which the main e2e
  // run (local `pnpm test:e2e` or the CI Tests workflow) provisions. Locally,
  // run it via `pnpm test:e2e:sso` against `pnpm idp:up` / `pnpm idp:scim:up`;
  // in CI it has its own workflow (.github/workflows/sso-e2e.yml) that stands
  // up the stack and runs all three sso/ specs.
  // verify-required/ is excluded for the same reason: it has its own config
  // (playwright.verify.config.ts) and needs a backend with
  // REQUIRE_EMAIL_VERIFICATION=true — the opposite of this run's flag-off
  // default. Locally: `pnpm test:e2e:verify` against a flag-on backend; in CI
  // it has its own verify-required job in .github/workflows/tests.yml.
  testIgnore: ["**/node_modules/**", "**/.auth/**", "**/fixtures/**", "**/sso/**", "**/verify-required/**"],

  // Stable on CI even with the dev server taking a beat to warm up.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  // One retry on CI absorbs incidental flake (dev-server transient HMR
  // errors, SSE reconnect blips). Zero retries locally so flakes are
  // visible during development.
  retries: process.env.CI ? 1 : 0,

  // Fail fast in CI — a single failure usually means the seed is
  // mis-stated and every dependent test would fail the same way.
  forbidOnly: !!process.env.CI,

  // Four workers by default — each Playwright worker (parallelIndex
  // 0..3) signs in as a dedicated seeded admin (admin+wN@example.com)
  // and operates exclusively on its dedicated org (acme-wN), so write-
  // heavy specs no longer collide on Acme's shared state. The wrapper
  // at fixtures/test.ts auto-resolves the per-worker storage state;
  // specs that import `test` from there pick up the isolation
  // automatically.
  //
  // Lower with PLAYWRIGHT_WORKERS=1 to debug, or bump it if you
  // re-seed with E2E_WORKER_TENANTS=N>4 (both must move in lockstep —
  // workers % WORKER_USERS.length loops indices, but you'll lose
  // isolation between paired workers if they share a tenant).
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? 4),
  fullyParallel: true,

  reporter: process.env.CI ? [["github"], ["list"]] : "list",

  // Auto-start the frontend dev server. `reuseExistingServer` lets a
  // manually-started server (e.g. for `playwright test --ui`) take
  // precedence locally.
  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:7778",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Vite logs are noisy; only surface them on failure.
    stdout: "ignore",
    stderr: "pipe",
    cwd: "..",
    env: {
      VITE_API_URL: process.env.E2E_BACKEND_URL ?? "http://localhost:3000",
    },
  },

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7778",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-GB",
    timezoneId: "UTC",
  },

  globalSetup: "./fixtures/auth.ts",

  // Chromium-only on purpose. Webkit + Firefox would 3x the runtime;
  // the cross-browser bug yield on a SvelteKit static site is low.
  // Add projects later if a bug ever shows up that's browser-specific.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
