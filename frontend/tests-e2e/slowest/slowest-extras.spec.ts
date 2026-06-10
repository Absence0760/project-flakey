import { expect, test } from "../fixtures/test";


/**
 * /slowest — coverage beyond the default smoke (slowest.spec.ts):
 * the summary-tile strip, the at-risk "getting slower" band + its
 * scroll-to-card click, the search box (narrow + filtered-empty),
 * the P95 sort tab, and ?q= URL round-trip.
 *
 * The worker-tenant seed reliably produces 50 slowest rows with a
 * spread of trend_pct values (≈20 trending > 10% slower), so the
 * at-risk band and summary tiles are always populated. We avoid
 * pinning exact counts (seed jitter) and instead anchor on structure
 * + relative behaviour.
 */

test.describe("/slowest — extras", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/slowest");
    await expect(page.locator(".test-list, .empty")).toBeVisible({ timeout: 10_000 });
    // Need real data for every assertion below.
    await expect(page.locator(".test-card").first()).toBeVisible({ timeout: 5_000 });
  });

  test("summary strip + pagination math agree (tracked = cards + load-more remainder)", async ({ page }) => {
    const tiles = page.locator(".summary .stat");
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0).locator(".stat-label")).toHaveText("Tracked tests");
    await expect(tiles.nth(1).locator(".stat-label")).toHaveText("Slowest avg");
    await expect(tiles.nth(2).locator(".stat-label")).toHaveText("Heavy-tail");
    await expect(tiles.nth(3).locator(".stat-label")).toHaveText("Regressing");

    // "Tracked tests" is the full unfiltered set (fetched with limit=100).
    // The list paginates client-side at PAGE_SIZE=50, so when tracked > 50
    // only 50 cards render and a "Load more (N more)" button accounts for
    // the rest. tracked === renderedCards + remainder must hold exactly.
    const tracked = Number(await tiles.nth(0).locator(".stat-value").textContent());
    expect(tracked).toBeGreaterThan(0);

    const renderedCards = await page.locator(".test-card").count();
    const loadMore = page.locator(".load-more-btn");
    if (await loadMore.count()) {
      const label = (await loadMore.textContent()) ?? "";
      const remainder = Number(label.match(/\((\d+) more\)/)?.[1] ?? "0");
      expect(renderedCards + remainder).toBe(tracked);
      expect(renderedCards).toBe(50); // PAGE_SIZE
    } else {
      // Whole set fits on one page.
      expect(renderedCards).toBe(tracked);
    }
  });

  test("load-more reveals the next page when the set exceeds one page", async ({ page }) => {
    const loadMore = page.locator(".load-more-btn");
    // The set has to exceed PAGE_SIZE (50) for load-more to exist; the
    // seed currently does, but stay graceful if a slim reseed doesn't.
    test.skip(!(await loadMore.count()), "set fits on one page — no pagination to exercise");

    const tracked = Number(
      await page.locator(".summary .stat").nth(0).locator(".stat-value").textContent(),
    );
    const before = await page.locator(".test-card").count();
    expect(before).toBe(50);
    await loadMore.click();
    // visibleCount grows by one PAGE_SIZE, clamped to the full set.
    await expect(page.locator(".test-card")).toHaveCount(
      Math.min(tracked, before + 50),
      { timeout: 2_000 },
    );
  });

  test("at-risk band lists regressing tests and clicking one expands its card", async ({ page }) => {
    const band = page.locator(".at-risk-band");
    await expect(band).toBeVisible();

    const items = band.locator(".at-risk-item");
    const itemCount = await items.count();
    // Capped at 5 by the page; seed yields well over that.
    expect(itemCount).toBeGreaterThan(0);
    expect(itemCount).toBeLessThanOrEqual(5);

    // Every banded trend badge is a positive percentage (the band is
    // "getting slower" only — trend_pct > 10).
    const firstTrend = await items.first().locator(".at-risk-trend").textContent();
    expect(firstTrend).toMatch(/^\+\d+%$/);

    // Clicking a band row scrolls the matching card into view and
    // expands it (scrollToTest sets expandedIndex). No card is
    // expanded before the click.
    await expect(page.locator(".test-card.expanded")).toHaveCount(0);
    await items.first().click();
    await expect(page.locator(".test-card.expanded")).toHaveCount(1, { timeout: 2_000 });
    await expect(page.locator(".test-card.expanded .test-detail")).toBeVisible();
  });

  test("search narrows the list and shows the 'showing N of M' summary", async ({ page }) => {
    // M in "showing N of M" is the full tracked set, not the rendered
    // (paginated) card count — read it from the summary tile.
    const total = Number(
      await page.locator(".summary .stat").nth(0).locator(".stat-value").textContent(),
    );

    // Take a token from the first card's visible title so the search is
    // guaranteed to match at least itself.
    const firstTitle = (await page.locator(".test-card .test-title").first().textContent())?.trim() ?? "";
    const token = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4);

    await page.locator(".search-box input").fill(token);

    // The "showing X of Y" summary appears only while a search is active.
    const summary = page.locator(".filter-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(`of ${total}`);

    // The matched count in the summary is non-empty and ≤ the full set,
    // and ?q= is written to the URL.
    const shown = Number((await summary.textContent())?.match(/showing (\d+) of/)?.[1] ?? "0");
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(total);
    expect(page.url()).toContain(`q=${encodeURIComponent(token)}`);
  });

  test("a non-matching search shows the filtered-empty state, not the global empty", async ({ page }) => {
    await page.locator(".search-box input").fill("zzz-no-such-test-zzz-qqq");

    const filteredEmpty = page.locator(".empty.filtered-empty");
    await expect(filteredEmpty).toBeVisible();
    await expect(filteredEmpty).toContainText("No tests match your search");
    // Cards are gone but the summary strip (full-set counts) stays.
    await expect(page.locator(".test-card")).toHaveCount(0);
    await expect(page.locator(".summary .stat")).toHaveCount(4);
  });

  test("P95 sort tab activates and writes ?sort=p95_ms", async ({ page }) => {
    const p95Tab = page.locator(".sort-bar .filter-tab", { hasText: /^P95$/ });
    await p95Tab.click();
    await expect(p95Tab).toHaveClass(/active/);
    expect(page.url()).toContain("sort=p95_ms");
  });

  test("?q= in the URL is restored on load (search box pre-filled, list filtered)", async ({ page }) => {
    // Pick a token from a card title, navigate fresh with it in the URL.
    const firstTitle = (await page.locator(".test-card .test-title").first().textContent())?.trim() ?? "";
    const token = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4);

    await page.goto(`/slowest?q=${encodeURIComponent(token)}`);
    await expect(page.locator(".test-list, .empty").first()).toBeVisible({ timeout: 10_000 });

    // The search input is pre-filled from the URL and the filter-summary
    // (active-search-only) is showing.
    await expect(page.locator(".search-box input")).toHaveValue(token);
    await expect(page.locator(".filter-summary")).toBeVisible();
  });
});
