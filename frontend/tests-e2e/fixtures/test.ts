import { test as base, expect } from "@playwright/test";

import { WORKER_USERS, type SeededUser } from "./users";

// Type-only re-exports. We can't `export * from "@playwright/test"` —
// pulling everything in collides with vitest/expect at runtime (both
// register their matcher symbols on the same global). Importing types
// is free at runtime, so specs can still do
//   import { test, expect, type Page } from "../fixtures/test";
// without a second import from "@playwright/test". Add new type
// re-exports here as specs need them.
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  ConsoleMessage,
  Cookie,
  Dialog,
  ElementHandle,
  Frame,
  Locator,
  Page,
  Request,
  Response,
  Route,
  TestInfo,
} from "@playwright/test";

/**
 * Worker-scoped Playwright test wrapper.
 *
 * Each Playwright worker (parallelIndex 0..N-1) is bound to its own
 * seeded admin user + org (acme-w<i>). Specs that import `test` from
 * this file automatically pick up the per-worker storageState — they
 * sign in as the worker's admin and operate against the worker's org.
 *
 * Two new fixtures are exposed:
 *
 *   workerAdminUser  — the SeededUser for this worker (admin+wN@…).
 *                       Use when a spec needs to assert against the
 *                       signed-in user's email/name or pass the user
 *                       into a helper (e.g. signIn).
 *
 *   workerAdminStorageState — the JSON path that
 *                       browser.newContext({ storageState: ... }) can
 *                       consume directly. Use when a spec needs a
 *                       second browser context attached to the same
 *                       tenant (xss-via-ingestion's two-tab tests).
 *
 * The default `storageState` is overridden so a spec that doesn't
 * explicitly `test.use({ storageState: ... })` lands in its worker's
 * tenant by default. Specs that override (VIEWER_USER, DEMO_USER, or
 * an unauthenticated `{ cookies: [], origins: [] }`) still work as
 * before — `test.use` wins at the describe-block level.
 *
 * NOT a substitute for ADMIN_USER (singular Acme admin). Keep using
 * ADMIN_USER directly for:
 *
 *   - Auth-flow specs that test the sign-in form (sign-in-out,
 *     auth-flows, auth-walls) — they assert against the form, not
 *     the workspace data, so per-worker isolation buys nothing and
 *     pinning to Acme avoids surprise.
 *
 *   - cross-tenant.spec.ts — needs the Acme + Demo Team pair to
 *     prove RLS isolation; worker tenants would not exercise the
 *     same boundary as DEMO_USER's org.
 *
 *   - VIEWER_USER (org_members.role = 'viewer') role-403 assertions.
 *
 * Re-exports `expect` for symmetry — every spec imports both
 * { test, expect } from this file so the wrapper is uniformly
 * applied across the suite.
 */

type WorkerFixtures = {
  workerAdminUser: SeededUser;
  workerAdminStorageState: string;
};

export const test = base.extend<object, WorkerFixtures>({
  workerAdminUser: [
    async ({}, use, workerInfo) => {
      // Modulo lets the suite degrade gracefully if a future config
      // bumps Playwright's worker count past the seeded WORKER_USERS
      // length — workers loop through the available tenants instead
      // of crashing on out-of-bounds index. (Bumping the seed in
      // lockstep is still the right answer.)
      const idx = workerInfo.parallelIndex % WORKER_USERS.length;
      await use(WORKER_USERS[idx]);
    },
    { scope: "worker" },
  ],

  workerAdminStorageState: [
    async ({ workerAdminUser }, use) => {
      await use(workerAdminUser.storageStatePath);
    },
    { scope: "worker" },
  ],

  // Per-test override of the built-in storageState fixture: default
  // to the worker's admin tenant. test.use({ storageState: ... }) at
  // the describe-block level still takes precedence for specs that
  // need a specific user (VIEWER_USER, DEMO_USER, unauthenticated).
  storageState: async ({ workerAdminStorageState }, use) => {
    await use(workerAdminStorageState);
  },
});

export { expect };
