import { expect, test } from "../fixtures/test";


/**
 * /flaky — interaction surfaces beyond the sort/window/suite controls
 * already covered by flaky.spec.ts + flaky-extras.spec.ts:
 *
 *  - the search box (narrow + ?q= sync + filtered-empty state),
 *  - the high-risk at-risk band (≥40% flake rate) and its
 *    scroll-to-row click,
 *  - the ?expanded=<full_title>|<suite> detail deep-link round-trip
 *    (open a row → URL carries the key → reload re-opens it via the
 *    stash-and-resolve effect).
 *
 * The worker-tenant seed reliably produces a flaky list with several
 * ≥40% tests, so the band is always populated; counts aren't pinned.
 */

test.describe("/flaky — search", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/flaky");
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });
  });

  test("search narrows the table, syncs ?q=, and shows the 'showing N of M' summary", async ({ page }) => {
    const total = await page.locator("tr.flaky-row").count();

    const firstTitle = (await page.locator("tr.flaky-row .test-title").first().textContent())?.trim() ?? "";
    const token = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4);

    await page.locator(".search-box input, input[placeholder='Search tests...']").fill(token);

    const summary = page.locator(".filter-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(`of ${total}`);
    expect(page.url()).toContain(`q=${encodeURIComponent(token)}`);

    const shown = await page.locator("tr.flaky-row").count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(total);
  });

  test("a non-matching search shows the filtered-empty state", async ({ page }) => {
    await page.locator("input[placeholder='Search tests...']").fill("zzz-no-such-flaky-test-qqq");
    await expect(page.locator(".empty.filtered-empty")).toBeVisible();
    await expect(page.locator("tr.flaky-row")).toHaveCount(0);
    // The summary strip (full-set counts) stays put.
    await expect(page.locator(".summary .stat").first()).toBeVisible();
  });
});

test.describe("/flaky — high-risk band", () => {

  test("the ≥40% at-risk band renders and clicking an item expands the matching row", async ({ page }) => {
    await page.goto("/flaky");
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });

    const band = page.locator(".at-risk-band");
    await expect(band).toBeVisible();

    const items = band.locator(".at-risk-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);

    // Each rate badge is ≥40% (the band's threshold).
    const rate = Number((await items.first().locator(".at-risk-rate").textContent())?.replace("%", ""));
    expect(rate).toBeGreaterThanOrEqual(40);

    await expect(page.locator("tr.flaky-row.expanded")).toHaveCount(0);
    await items.first().click();
    // scrollToTest expands the matching row and deep-links it.
    await expect(page.locator("tr.flaky-row.expanded")).toHaveCount(1, { timeout: 2_000 });
    expect(page.url()).toContain("expanded=");
  });
});

test.describe("/flaky — ?expanded deep-link", () => {

  test("opening a row writes ?expanded= and a reload re-opens the same detail panel", async ({ page }) => {
    await page.goto("/flaky");
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });

    // Open the first row; the detail row + ?expanded= appear.
    await page.locator("tr.flaky-row").first().click();
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1);
    const url = new URL(page.url());
    const key = url.searchParams.get("expanded");
    expect(key, "opening a row should write ?expanded=<key>").toBeTruthy();

    // Reload straight from the deep link — the stash-and-resolve effect
    // must re-open the same detail panel once data lands.
    await page.goto(`/flaky?expanded=${encodeURIComponent(key!)}`);
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1, { timeout: 5_000 });
  });

  test("closing a row clears ?expanded= from the URL", async ({ page }) => {
    await page.goto("/flaky");
    const firstRow = page.locator("tr.flaky-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });

    await firstRow.click();
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1);
    expect(page.url()).toContain("expanded=");

    // Clicking the open row again collapses it and drops the param.
    await firstRow.click();
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("expanded")).toBeNull();
  });
});
