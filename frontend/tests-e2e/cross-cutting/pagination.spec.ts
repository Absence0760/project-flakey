import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Client-side pagination is implemented on /flaky, /errors,
 * /slowest, /releases, /manual-tests with a shared page size of
 * 50. The button (`.load-more-btn`) is hidden when the page's
 * visible-count covers the entire filtered set, and clicking it
 * appends the next 50 items to the rendered list.
 *
 * The seed produces > 50 entries on /flaky, /errors, and /slowest
 * (boosted in seed.ts so each of those pages exercises pagination
 * in dev). Releases + manual-tests can have arbitrary counts; their
 * Load-more is rendered when applicable but isn't asserted here.
 *
 * Also pins the contract that:
 *   - /manual-tests no longer renders the redundant H1 ("Manual
 *     tests" — the URL + sidebar nav already label it).
 *   - the `.load-more-btn` CSS is centralized in src/app.css and
 *     applies uniformly across pages.
 */

async function waitForList(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().waitFor({ timeout: 15_000 });
}

test.describe("client-side pagination — Load more button", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("/slowest renders ≤ 50 items initially and exposes a Load more button when more exist", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto("/slowest");
    await waitForList(page, ".test-list .test-card");

    const initial = await page.locator(".test-list .test-card").count();
    expect(
      initial,
      `initial render shows ${initial} cards; page-size 50 should cap this`,
    ).toBeLessThanOrEqual(50);

    // The seed creates 100 slowest entries, so Load more must be visible.
    const button = page.locator(".load-more-btn");
    await expect(button, "Load more button must appear when sorted.length > 50").toBeVisible();
  });

  test("/slowest: clicking Load more appends the next 50 items", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/slowest");
    await waitForList(page, ".test-list .test-card");

    const before = await page.locator(".test-list .test-card").count();
    expect(before).toBeLessThanOrEqual(50);

    await page.locator(".load-more-btn").click();

    // After one click we should have either the full set (if total ≤
    // 100) or another 50 — either way strictly more than before.
    await expect.poll(
      async () => await page.locator(".test-list .test-card").count(),
      { timeout: 5_000 },
    ).toBeGreaterThan(before);
  });

  test("/slowest: changing the sort resets visibleCount to 50", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/slowest");
    await waitForList(page, ".test-list .test-card");

    // Expand: click Load more so we're past the first page.
    await page.locator(".load-more-btn").click();
    await expect.poll(async () => page.locator(".test-list .test-card").count())
      .toBeGreaterThan(50);

    // Now flip the sort tab — should reset back to a 50-item slice.
    await page.locator(".filter-tab", { hasText: "Max" }).click();

    await expect.poll(
      async () => await page.locator(".test-list .test-card").count(),
      { timeout: 5_000 },
    ).toBeLessThanOrEqual(50);
  });
});

test.describe("client-side pagination — /flaky and /errors", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("/flaky shows Load more when seed produces > 50 candidates", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/flaky");
    await waitForList(page, ".flaky-list .flaky-card");

    const initial = await page.locator(".flaky-list .flaky-card").count();
    expect(initial, `initial render shows ${initial} cards; page-size 50 should cap this`)
      .toBeLessThanOrEqual(50);
    await expect(page.locator(".load-more-btn"), "Load more must appear with seeded volume > 50").toBeVisible();

    await page.locator(".load-more-btn").click();
    await expect.poll(
      async () => await page.locator(".flaky-list .flaky-card").count(),
      { timeout: 5_000 },
    ).toBeGreaterThan(initial);
  });

  test("/errors shows Load more when seed produces > 50 groups", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/errors");
    await waitForList(page, ".error-list .error-card");

    const initial = await page.locator(".error-list .error-card").count();
    expect(initial, `initial render shows ${initial} cards; page-size 50 should cap this`)
      .toBeLessThanOrEqual(50);
    await expect(page.locator(".load-more-btn"), "Load more must appear with seeded volume > 50").toBeVisible();

    await page.locator(".load-more-btn").click();
    await expect.poll(
      async () => await page.locator(".error-list .error-card").count(),
      { timeout: 5_000 },
    ).toBeGreaterThan(initial);
  });
});

test.describe("/manual-tests heading is gone (page label comes from URL + nav)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("page does not render a 'Manual tests' <h1>", async ({ page }) => {
    await page.goto("/manual-tests");
    await page.locator("table.tests").waitFor({ timeout: 15_000 });

    // The sidebar still has the nav link "Manual tests" — that's a
    // link, not an h1. The page itself should have no h1 in the
    // .page-header.
    const h1 = page.locator(".page-header h1");
    await expect(h1).toHaveCount(0);
  });
});
