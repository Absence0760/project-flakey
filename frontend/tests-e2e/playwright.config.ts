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
  // Don't recurse into .auth/ or fixtures/ from the testDir glob.
  testIgnore: ["**/node_modules/**", "**/.auth/**", "**/fixtures/**"],

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

  // Single worker — tests share one seeded Postgres + one dev server,
  // and the upload-merge / live-flow paths aren't isolated per page
  // context. Bump up after the suite is stable and per-org isolation
  // is in place.
  workers: 1,
  fullyParallel: false,

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
