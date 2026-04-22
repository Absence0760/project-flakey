/**
 * Visual regression tests using Playwright's built-in toHaveScreenshot.
 *
 * Baselines are stored in tests/visual/app-visual.spec.ts-snapshots/.
 * To regenerate baselines after an intentional UI change, run:
 *   pnpm test:visual:update
 */

import { test, expect } from "@playwright/test";

test.describe("Visual regression — main app views", () => {
  test("login page matches baseline", async ({ page }) => {
    await page.goto("/#login");
    // Wait for the page to be fully settled
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("login-page.png", {
      fullPage: true,
    });
  });

  test("todos page matches baseline", async ({ page }) => {
    await page.goto("/#todos");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("todos-page.png", {
      fullPage: true,
    });
  });

  test("todos page with items matches baseline", async ({ page }) => {
    await page.goto("/#todos");
    await page.waitForLoadState("networkidle");

    // Add a couple of todos so the state is non-trivial
    await page.getByTestId("todo-input").fill("Write tests");
    await page.getByTestId("todo-input").press("Enter");
    await page.getByTestId("todo-input").fill("Review PR");
    await page.getByTestId("todo-input").press("Enter");

    await expect(page).toHaveScreenshot("todos-page-with-items.png", {
      fullPage: true,
    });
  });
});
