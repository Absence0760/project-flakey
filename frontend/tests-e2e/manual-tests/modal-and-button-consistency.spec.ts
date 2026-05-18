import { expect, test, type Page } from "../fixtures/test";


/**
 * Two regressions on /manual-tests, both reported from manual
 * testing:
 *
 * 1. The create + detail modals capped at `width: min(1100px, 95vw)`
 *    wasted ~700 px on a 2K monitor. Bumped to `min(1800px, 95vw)`
 *    so the steps table + runner can use the available real estate.
 *
 * 2. `.btn-primary` (padding 0.45 0.9) and `.btn-ghost` (padding
 *    0.35 0.7) had different paddings, so the three header buttons
 *    rendered at different heights side-by-side. Now both share
 *    `padding: 0.45rem 0.9rem` and a 1px border so the box-model
 *    height matches; the visual hierarchy comes from
 *    background/color, not size.
 */

const WIDE_VIEWPORT = { width: 2560, height: 1440 };

async function openCreateModal(page: Page): Promise<void> {
  await page.goto("/manual-tests");
  await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /\+ New test/ }).click();
  await expect(page.locator(".modal.create-modal")).toBeVisible({ timeout: 5_000 });
}

test.describe("/manual-tests modal width on a wide viewport", () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test("create modal uses the wider cap on a 2560-wide viewport", async ({ page }) => {
    test.setTimeout(30_000);
    await openCreateModal(page);

    const modal = page.locator(".modal.create-modal");
    const width = await modal.evaluate((el) => el.getBoundingClientRect().width);

    // Old cap rendered exactly 1100 px. New cap is 1800 px; allow a
    // small buffer for box-sizing. 1700 is well above the old cap
    // and just below the new one — fails decisively on regression.
    expect(
      width,
      `.modal.create-modal width (${width.toFixed(0)} px) is below the new 1800 px cap`,
    ).toBeGreaterThanOrEqual(1700);
    expect(width).toBeLessThanOrEqual(1800);
  });
});

test.describe("/manual-tests header buttons render at the same height", () => {

  test("all .header-actions buttons share the same rendered height", async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    const buttons = page.locator(".header-actions button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const heights = await buttons.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );

    // All buttons in the header row should be the same height to
    // within a sub-pixel rounding budget. Before the fix the ghost
    // buttons were ~4 px shorter than .btn-primary because of
    // asymmetric padding + missing border on primary.
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    expect(
      max - min,
      `header buttons render at ${heights.map((h) => h.toFixed(1)).join(", ")} — heights must match (±1 px)`,
    ).toBeLessThanOrEqual(1);
  });
});
