import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Theme is system-driven only. The sidebar previously had a
 * Light/Dark/System cycle button, but the `:has()` selector that
 * was supposed to let `data-theme="light"` override a dark system
 * never matched (it walks descendants, not the root itself). Two
 * of three toggle states happened to align with the system, so
 * the bug was invisible until a dark-system user clicked "light"
 * and saw nothing change.
 *
 * After removing the toggle, these specs pin the contract that:
 *   - the dashboard reflects the system theme via
 *     `@media (prefers-color-scheme: …)` on app.css' :root vars,
 *   - no `.theme-toggle` button exists (regression guard),
 *   - the `theme` localStorage key is wiped on mount so stale
 *     values from older sessions can't leak into anything new.
 */

async function readBg(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  );
}

test.describe("theme is system-driven only", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("dark system → dark --bg", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
    expect(await readBg(page)).toBe("#0d1117");
  });

  test("light system → light --bg", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
    expect(await readBg(page)).toBe("#ffffff");
  });

  test("the sidebar no longer renders a `.theme-toggle` button (regression guard)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
    await expect(page.locator(".theme-toggle")).toHaveCount(0);
  });

  test("a stale `theme` localStorage entry is cleared on mount", async ({ page }) => {
    // Seed a stale entry BEFORE the layout's onMount runs. We do
    // this via addInitScript so it's set before any page script.
    await page.addInitScript(() => {
      try { localStorage.setItem("theme", "dark"); } catch { /* ignore */ }
    });
    await page.goto("/");
    await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });

    const remaining = await page.evaluate(() => localStorage.getItem("theme"));
    expect(remaining, "layout onMount must wipe the legacy theme key").toBeNull();
  });
});
