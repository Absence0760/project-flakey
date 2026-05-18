import { expect, test, type Page } from "../fixtures/test";


/**
 * Page-width regression for the .page max-width cap.
 *
 * Every (app)/* route renders content inside a `<div class="page">`
 * that caps its width and centers itself with `margin: 0 auto`. The
 * cap was 1440px, which left ~460 px of dead space on each side of
 * content on a 2K monitor (2560 px viewport minus a 200 px sidebar).
 * Bumped to 1920 px so the dashboard actually uses the real estate
 * on common modern monitor sizes.
 *
 * The regression these specs guard against is a future refactor
 * lowering the cap below 1920 — or removing the cap entirely without
 * intent (which would also flake the assertions, but in the opposite
 * direction). We don't pin a precise `getBoundingClientRect` width
 * because internal padding can vary per page; we assert that on a
 * 2K-equivalent viewport the visible content extends to within
 * ~240 px of the right edge (well inside the old 1440 cap's 460 px
 * gap, well outside any future accidental shrink).
 */

const SIDEBAR_WIDTH = 200;
const WIDE_VIEWPORT = { width: 2560, height: 1440 };

async function pageRightEdgeGap(page: Page): Promise<number> {
  // Measure the actual right-edge gap between the `.page` container
  // and the viewport's right edge. The sidebar is on the left, so
  // this captures the "right gutter" the user was complaining about.
  return page.evaluate(() => {
    const el = document.querySelector(".page") as HTMLElement | null;
    if (!el) throw new Error(".page element not found on this route");
    const rect = el.getBoundingClientRect();
    return window.innerWidth - rect.right;
  });
}

async function pageWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector(".page") as HTMLElement | null;
    if (!el) throw new Error(".page element not found on this route");
    return el.getBoundingClientRect().width;
  });
}

test.describe("(app)/* .page cap uses the full real estate on wide monitors", () => {
  test.use({ viewport: WIDE_VIEWPORT });

  // One route per page-shape so a future style refactor that
  // accidentally drops the new cap on one route is caught here.
  const ROUTES = [
    { label: "runs list (/)", path: "/" },
    { label: "/dashboard", path: "/dashboard" },
    { label: "/flaky", path: "/flaky" },
    { label: "/slowest", path: "/slowest" },
    { label: "/errors", path: "/errors" },
    { label: "/releases", path: "/releases" },
    { label: "/manual-tests", path: "/manual-tests" },
    { label: "/settings", path: "/settings" },
  ];

  for (const { label, path } of ROUTES) {
    test(`${label}: .page width is at least 1700 px and gap is under 280 px on a 2560-wide viewport`, async ({
      page,
    }) => {
      await page.goto(path);
      // Wait for first paint of the page container itself.
      await expect(page.locator(".page")).toBeVisible({ timeout: 15_000 });

      const width = await pageWidth(page);
      const gap = await pageRightEdgeGap(page);

      // Old cap was 1440 px (gap ≈ 460 on a 2560 viewport with 200 px
      // sidebar). New cap is 1920 px (gap ≈ 220). 280 is a generous
      // ceiling that admits a few px of padding/border slop while
      // still failing decisively if anyone reverts to the 1440 cap.
      expect(
        gap,
        `${label}: right-edge gap (${gap.toFixed(0)} px) is bigger than the regression budget — the 1440 cap may be back`,
      ).toBeLessThan(280);

      // Lower bound: content must actually use the cap. 1700 leaves
      // a buffer for inner padding without false-flagging a tighter
      // form-style cap inside a specific page.
      expect(
        width,
        `${label}: .page width (${width.toFixed(0)} px) is below the new 1920 cap minus reasonable padding`,
      ).toBeGreaterThanOrEqual(1700);

      // Sanity: width + gap + sidebar shouldn't exceed the viewport
      // (would indicate horizontal scroll, which the main layout
      // explicitly disables via overflow-x: hidden).
      expect(
        width + gap + SIDEBAR_WIDTH,
        `${label}: .page extends past the visible viewport`,
      ).toBeLessThanOrEqual(WIDE_VIEWPORT.width);
    });
  }
});
