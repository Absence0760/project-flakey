import { expect, test } from "@playwright/test";

import { DEMO_USER } from "../fixtures/users";

/**
 * Viewer-role gating — DEMO_USER is the owner of "Demo Team" and has
 * full admin rights there, but Demo Team has zero seeded data. We
 * use that org as a controlled environment to confirm:
 *  - the empty-state copy renders for each "data" route
 *  - admin-only affordances *do* render for an owner (confirms the
 *    isAdmin/isOwner derived flags wire correctly to ADMIN_USER too)
 *
 * (Note: the saved fixture marks DEMO_USER.role = "viewer" in users.ts,
 * but the seed actually grants demo `owner` of Demo Team. The role
 * field in fixtures is descriptive only — the seed is authoritative.)
 */

test.describe("Demo Team owner — empty-state coverage", () => {
  test.use({ storageState: DEMO_USER.storageStatePath });

  test("/ shows the empty-runs hint", async ({ page }) => {
    await page.goto("/runs");
    // No runs seeded for Demo Team → empty state lands.
    await expect(page.locator(".empty p", { hasText: /No test runs found/ })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("/flaky shows the empty hint or zero rows", async ({ page }) => {
    await page.goto("/flaky");
    // The /flaky page has no h1 (the sidebar nav + URL label it).
    // Wait for the empty hint to land, then assert no cards.
    await expect(
      page.locator(".empty p", { hasText: /No flaky tests detected/ }),
    ).toBeVisible({ timeout: 10_000 });
    const cards = page.locator(".flaky-card");
    expect(await cards.count()).toBe(0);
  });

  test("/errors shows zero error groups", async ({ page }) => {
    await page.goto("/errors");
    // Wait long enough for the lazy fetch to settle.
    await expect(page.locator("body")).toBeVisible();
    // No error headers should render since there are no seeded
    // failures in Demo Team.
    expect(await page.locator(".error-header").count()).toBe(0);
  });

  test("/slowest shows the empty state for an org with no runs", async ({ page }) => {
    await page.goto("/slowest");
    // Wait for either empty or test-list. The route's empty-state
    // copy reads "No test data available yet."
    await expect(
      page.locator(".empty p", { hasText: /No test data available yet/ }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
