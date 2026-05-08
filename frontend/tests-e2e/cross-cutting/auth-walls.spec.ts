import { expect, test } from "@playwright/test";

/**
 * Auth walls — every (app)/* route bounces an unauthenticated
 * visitor to /login.
 *
 * The redirect is enforced client-side in routes/(app)/+layout.svelte:
 * onMount runs restoreAuth(); if there's no token, it goto('/login').
 * The same subscription path also catches token clearance mid-session
 * (covered by sign-in-out.spec.ts).
 *
 * If a new (app) route is added, append it to PROTECTED_ROUTES so the
 * wall is exercised. A route that doesn't redirect — i.e. renders
 * empty/broken with the unauth fall-through — would be a Critical
 * leak (any data fetched server-side or via authFetch silently 401s
 * but the page still mounts).
 */

const PROTECTED_ROUTES = [
  "/",
  "/dashboard",
  "/flaky",
  "/slowest",
  "/errors",
  "/manual-tests",
  "/releases",
  "/settings",
  "/settings/integrations",
  "/runs/1",
  "/compare",
];

test.describe("(app)/* routes require auth", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const route of PROTECTED_ROUTES) {
    test(`unauthenticated visit to ${route} redirects to /login`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    });
  }
});
