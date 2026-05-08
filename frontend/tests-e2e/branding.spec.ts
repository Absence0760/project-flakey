import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * Better Testing branding — the rebrand from "Flakey" landed in commit
 * 95efd7d. User-facing copy must say "Better Testing", not "Flakey".
 *
 * Per CLAUDE.md: npm package scopes (@flakeytesting/*) and the repo
 * directory keep the old name; only user-facing strings rebrand.
 */

test.describe("Better Testing branding consistency", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("sidebar nav header reads 'Better Testing' (not Flakey)", async ({ page }) => {
    await page.goto("/dashboard");
    // The sidebar's app-name area renders "Better Testing".
    await expect(page.locator("body")).toContainText("Better Testing", { timeout: 10_000 });
    // No user-facing string should still say "Flakey" in the nav.
    const sidebarText = (await page.locator("nav, aside, [role='navigation']").first().textContent()) ?? "";
    expect(sidebarText.toLowerCase()).not.toContain("flakey");
  });

  test("login page brand matches", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto("/login");
      await expect(page.locator("body")).toContainText("Better Testing", { timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });

  test("page <title> on /dashboard reflects the brand", async ({ page }) => {
    await page.goto("/dashboard");
    const title = await page.title();
    // Either contains "Better Testing" or at minimum doesn't say
    // "Flakey" (the rebrand contract).
    expect(title.toLowerCase()).not.toContain("flakey");
  });

  test("sidebar visits across routes never surface 'Flakey' branding", async ({ page }) => {
    const routes = ["/dashboard", "/flaky", "/manual-tests", "/releases", "/settings"];
    for (const r of routes) {
      await page.goto(r);
      const sidebarText =
        (await page.locator("nav, aside, [role='navigation']").first().textContent()) ?? "";
      expect(sidebarText.toLowerCase(), `Sidebar on ${r} should not say Flakey`).not.toContain(
        "flakey",
      );
    }
  });
});
