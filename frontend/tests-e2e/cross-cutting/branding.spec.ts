import { expect, test } from "../fixtures/test";


/**
 * Flakey branding — user-facing copy reads "Flakey".
 *
 * Notes on internal naming the rebrand intentionally does NOT touch:
 *   - npm package scope stays `@flakeytesting/*` (publishing inertia).
 *   - The repo directory is still `project-flakey`.
 *   - The auth singleton's localStorage prefix is still `bt_*` —
 *     not user-visible, no migration cost worth paying to flip.
 *
 * Anything user-visible (page <title>, sidebar header, login page,
 * outgoing email subjects/from) must say Flakey.
 */

test.describe("Flakey branding consistency", () => {

  test("sidebar nav header reads 'Flakey'", async ({ page }) => {
    await page.goto("/dashboard");
    // The sidebar's app-name area renders "Flakey".
    const sidebar = page.locator("nav, aside, [role='navigation']").first();
    await expect(sidebar).toContainText("Flakey", { timeout: 10_000 });
    // No stale "Better Testing" should remain anywhere in the nav.
    const sidebarText = (await sidebar.textContent()) ?? "";
    expect(sidebarText.toLowerCase()).not.toContain("better testing");
  });

  test("login page brand matches", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto("/login");
      await expect(page.locator("body")).toContainText("Flakey", { timeout: 10_000 });
      const bodyText = (await page.locator("body").textContent()) ?? "";
      expect(bodyText.toLowerCase()).not.toContain("better testing");
    } finally {
      await ctx.close();
    }
  });

  test("page <title> on /dashboard reflects the brand", async ({ page }) => {
    await page.goto("/dashboard");
    const title = await page.title();
    expect(title.toLowerCase()).toContain("flakey");
    expect(title.toLowerCase()).not.toContain("better testing");
  });

  test("sidebar across routes consistently shows 'Flakey'", async ({ page }) => {
    const routes = ["/dashboard", "/flaky", "/manual-tests", "/releases", "/settings"];
    for (const r of routes) {
      await page.goto(r);
      const sidebar = page.locator("nav, aside, [role='navigation']").first();
      const sidebarText = (await sidebar.textContent()) ?? "";
      expect(sidebarText, `sidebar on ${r} should show 'Flakey'`).toContain("Flakey");
      expect(
        sidebarText.toLowerCase(),
        `sidebar on ${r} should not retain 'Better Testing'`,
      ).not.toContain("better testing");
    }
  });
});
