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
    const firstTitle = (await page.locator("tr.flaky-row .test-title").first().textContent())?.trim() ?? "";
    const token = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4);

    await page.locator(".search-box input, input[placeholder='Search tests...']").fill(token);

    // The summary only renders once a filter is active (search or non-default
    // suite). Parse counts from it directly: "showing N of M" where M is the
    // app's true total flaky count (tests.length) and N is the search matches.
    // M is NOT the rendered-row count — the table paginates at PAGE_SIZE=50, so
    // counting tr.flaky-row would understate the total once the seed yields >50.
    const summary = page.locator(".filter-summary");
    await expect(summary).toBeVisible();
    expect(page.url()).toContain(`q=${encodeURIComponent(token)}`);

    const text = (await summary.textContent()) ?? "";
    const matched = Number(text.match(/showing\s+(\d+)/)?.[1]);
    const total = Number(text.match(/of\s+(\d+)/)?.[1]);
    expect(total).toBeGreaterThan(0);
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThanOrEqual(total);
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

  test("re-sorting keeps the open panel on the SAME test (no positional-index drift)", async ({ page }) => {
    // Regression: the open detail panel used to be tracked by its positional
    // index into the filtered+sorted list. Re-sorting reorders that list while
    // the index stayed put, so the panel silently jumped to whatever test
    // landed at the old index. It's now keyed by the stable full_title|suite,
    // so the open panel must follow its test across a re-sort.
    await page.goto("/flaky");
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });

    // Open a row that is NOT first under the default sort, so a re-sort is
    // very likely to move it to a different index. Row index 2 (3rd row).
    const targetRow = page.locator("tr.flaky-row").nth(2);
    const openedTitle = (await targetRow.locator(".test-title").textContent())?.trim() ?? "";
    expect(openedTitle).not.toBe("");

    await targetRow.click();
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1);
    const keyBefore = new URL(page.url()).searchParams.get("expanded");
    expect(keyBefore).toBeTruthy();

    // Re-sort by a different column — the list reorders.
    await page.locator(".sort-bar .filter-tab", { hasText: "Last seen" }).click();
    await expect(page).toHaveURL(/sort=last_seen/);

    // Exactly one panel is open, and it still belongs to the SAME test —
    // not whatever row now sits at the old index 2. The ?expanded key is
    // unchanged too.
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1);
    const expandedRow = page.locator("tr.flaky-row.expanded");
    await expect(expandedRow).toHaveCount(1);
    await expect(expandedRow.locator(".test-title")).toHaveText(openedTitle);
    expect(new URL(page.url()).searchParams.get("expanded")).toBe(keyBefore);
  });

  test("filtering out the open test collapses its panel cleanly", async ({ page }) => {
    // With index-based tracking, narrowing the list so the open test is gone
    // left the index pointing at an unrelated surviving row (or out of range).
    // Keyed tracking means the panel just disappears when its test is filtered
    // out — no panel attaches to a different test.
    await page.goto("/flaky");
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });

    const firstRow = page.locator("tr.flaky-row").first();
    const openedTitle = (await firstRow.locator(".test-title").textContent())?.trim() ?? "";
    await firstRow.click();
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(1);

    // Search for something that cannot match the opened test, narrowing the
    // list. The opened panel must not survive attached to a surviving row.
    await page.locator("input[placeholder='Search tests...']").fill("zzz-no-such-flaky-test-qqq");
    await expect(page.locator("tr.flaky-row")).toHaveCount(0);
    await expect(page.locator("tr.flaky-detail-row")).toHaveCount(0);
    // Sanity: the title we opened is genuinely not the search token.
    expect(openedTitle.toLowerCase()).not.toContain("zzz-no-such-flaky-test-qqq");
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
