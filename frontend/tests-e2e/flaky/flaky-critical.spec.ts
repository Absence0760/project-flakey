import { expect, test } from "../fixtures/test";
import { DEMO_USER } from "../fixtures/users";

/**
 * /flaky — critical correctness coverage.
 *
 * The flaky page is the product's namesake: what it shows as "flaky",
 * how it ranks those tests, and the per-test drill-down are the core
 * value. The existing specs (flaky.spec.ts / flaky-extras.spec.ts /
 * flaky-interaction.spec.ts) cover the filter/sort/search *chrome*,
 * the at-risk band, and the ?expanded deep-link key-stability
 * regression. They deliberately do NOT assert that the rendered
 * numbers and ordering match the underlying data, nor the genuinely
 * empty org, nor a full multi-param URL round-trip.
 *
 * This file fills those gaps — the assertions that protect
 * trustworthiness rather than just "the control flipped a class":
 *
 *  1. true empty state for an org with no runs (DEMO_USER),
 *  2. each sort tab actually orders the visible rows by the metric it
 *     names (descending) — the ranking math, not just the active class,
 *  3. the summary-tile risk counts agree with the rendered rate pills
 *     (High = #rows ≥40%, Medium = #rows 20–40%),
 *  4. opening a row drills into real per-test detail (first-seen +
 *     quarantine control + the run-keyed timeline),
 *  5. suite + sort + window survive a hard reload (URL-state round-trip).
 *
 * Read-only against the per-worker seeded tenant (acme-w<N>), whose
 * seed reliably yields a populated flaky list; the empty-state test
 * pins to DEMO_USER (owner of an org with zero runs).
 */

const READY = '.page[data-ready="true"]';

/** Parse the integer percentage out of a rate pill ("37%" → 37). */
function pct(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.-]/g, ""));
}

test.describe("/flaky — critical correctness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/flaky");
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });
    // Populated worker tenant — rows are present once ready.
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });
  });

  test("summary-tile risk counts agree with the rendered rate pills", async ({ page }) => {
    // The summary strip's "High risk" (≥40%) and "Medium" (20–40%)
    // tiles are derived from the full unfiltered `tests` set. With no
    // search/suite filter active, every flaky test is rendered (modulo
    // the 50-row pagination cap), so for the comparison to be exact we
    // first read the app's own total off the "Flaky tests" tile and
    // only assert exactness when the whole set fits on one page.
    const totalTile = page.locator(".summary .stat", { hasText: "Flaky tests" });
    const total = pct(await totalTile.locator(".stat-value").textContent());
    expect(total).toBeGreaterThan(0);

    const highTile = page.locator(".summary .stat", { hasText: "High risk" });
    const mediumTile = page.locator(".summary .stat", { hasText: "Medium" });
    const high = pct(await highTile.locator(".stat-value").textContent());
    const medium = pct(await mediumTile.locator(".stat-value").textContent());

    // The tiles partition the set: high + medium can never exceed the
    // total, and (given the rate buckets) high ≤ total, medium ≤ total.
    expect(high + medium).toBeLessThanOrEqual(total);

    // Cross-check against the rate pills actually painted in the table.
    // Only meaningful when the entire set is on one page (no "Load more"),
    // otherwise the off-page rows aren't counted here.
    const loadMore = page.locator(".load-more-btn");
    if ((await loadMore.count()) === 0) {
      const rates = (
        await page.locator("tr.flaky-row .rate-pill").allTextContents()
      ).map(pct);
      expect(rates.length).toBe(total);
      const renderedHigh = rates.filter((r) => r >= 40).length;
      const renderedMedium = rates.filter((r) => r >= 20 && r < 40).length;
      expect(renderedHigh).toBe(high);
      expect(renderedMedium).toBe(medium);
    }
  });

  test("the 'Flaky rate' sort orders visible rows by descending rate", async ({ page }) => {
    // Default sort is Flaky rate — assert the visible rate pills are
    // monotonically non-increasing. This is the ranking guarantee: the
    // worst offenders must surface at the top.
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: "Flaky rate" }),
    ).toHaveClass(/active/);

    const rates = (
      await page.locator("tr.flaky-row .rate-pill").allTextContents()
    ).map(pct);
    expect(rates.length).toBeGreaterThan(1);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
    }
  });

  test("the 'Flips' sort orders visible rows by descending flip count", async ({ page }) => {
    await page.locator(".sort-bar .filter-tab", { hasText: "Flips" }).click();
    await expect(page).toHaveURL(/sort=flip_count/);
    // Wait for the new ordering to settle before reading — the active
    // class flip is the real signal the derived `sorted` recomputed.
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: "Flips" }),
    ).toHaveClass(/active/);

    const flips = (
      await page.locator("tr.flaky-row td.col-flips strong").allTextContents()
    ).map((t) => Number(t.trim()));
    expect(flips.length).toBeGreaterThan(1);
    for (let i = 1; i < flips.length; i++) {
      expect(flips[i]).toBeLessThanOrEqual(flips[i - 1]);
    }
  });

  test("the 'Last seen' sort orders visible rows newest-first", async ({ page }) => {
    // Capture each row's absolute last-seen (the title attr on .col-last
    // carries the absoluteDate — a parseable timestamp, unlike the
    // relative "3d ago" text).
    await page.locator(".sort-bar .filter-tab", { hasText: "Last seen" }).click();
    await expect(page).toHaveURL(/sort=last_seen/);
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: "Last seen" }),
    ).toHaveClass(/active/);

    const titles = await page
      .locator("tr.flaky-row td.col-last")
      .evaluateAll((tds) =>
        (tds as HTMLElement[]).map((td) => td.getAttribute("title") ?? ""),
      );
    const times = titles.map((t) => Date.parse(t));
    expect(times.length).toBeGreaterThan(1);
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });

  test("opening a row drills into real per-test detail (first-seen + quarantine + run-keyed timeline)", async ({
    page,
  }) => {
    // The drill-down is the from-list-to-root-cause moment. Assert it
    // carries the per-test affordances, not just that *a* panel opened.
    const firstRow = page.locator("tr.flaky-row").first();

    // The timeline dots on the row are titled "Run #<id>: <status>" —
    // the link from a flaky pattern back to the actual runs. Verify the
    // run ids are present so a drill-down can reach the run detail.
    const firstDotTitle = await firstRow
      .locator(".timeline .timeline-dot")
      .first()
      .getAttribute("title");
    expect(firstDotTitle).toMatch(/^Run #\d+: (passed|failed|skipped)$/);

    await firstRow.click();
    const detail = page.locator("tr.flaky-detail-row");
    await expect(detail).toHaveCount(1);

    // Per-test metadata: a "first seen …" tag and the Quarantine
    // control (this row is not quarantined in the seed, so the button
    // reads "Quarantine", not "Unquarantine").
    await expect(detail.locator(".meta-tag")).toContainText(/first seen/i);
    await expect(
      detail.getByRole("button", { name: /^Quarantine$/ }),
    ).toBeVisible();
    // The notes panel mounts inside the drill-down — the per-test
    // collaboration affordance that makes the panel a real triage unit.
    await expect(detail.locator(".notes-panel")).toBeVisible();
  });

  test("suite + sort + window survive a hard reload (URL-state round-trip)", async ({ page }) => {
    // Pick a concrete non-default suite from the filter so the round-trip
    // proves a real value persists (not just the default).
    const suiteSelect = page.locator(".filters select").first();
    const opts = await suiteSelect
      .locator("option")
      .evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value));
    const suiteChoice = opts.find((o) => o !== "all") ?? "all";
    expect(suiteChoice).not.toBe("all");

    await suiteSelect.selectOption(suiteChoice);
    await page.locator(".sort-bar .filter-tab", { hasText: "Failures" }).click();
    await page.locator(".filters .filter-tabs .filter-tab", { hasText: /^50 runs$/ }).click();

    // All three params must now be in the URL.
    await expect(page).toHaveURL(/sort=fail_count/);
    await expect(page).toHaveURL(/window=50/);
    await expect(page).toHaveURL(new RegExp(`suite=${encodeURIComponent(suiteChoice).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // Hard reload from the URL — the page must rehydrate the same state.
    await page.reload();
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });

    await expect(suiteSelect).toHaveValue(suiteChoice);
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: "Failures" }),
    ).toHaveClass(/active/);
    await expect(
      page.locator(".filters .filter-tabs .filter-tab", { hasText: /^50 runs$/ }),
    ).toHaveClass(/active/);
    // URL still carries them after the round-trip (the read→sync cycle
    // is idempotent — it must not drop a non-default value on rehydrate).
    await expect(page).toHaveURL(/sort=fail_count/);
    await expect(page).toHaveURL(/window=50/);
  });
});

test.describe("/flaky — empty org", () => {
  // DEMO_USER owns Demo Team, an org the seed creates with zero runs,
  // so flaky detection has nothing to compute over. The page must show
  // the genuine empty state (not the filtered-empty one, and not an
  // error), proving the ≥1-row assumption baked into the other specs
  // is a property of the *data*, not the page.
  test.use({ storageState: DEMO_USER.storageStatePath });

  test("an org with no runs shows the 'No flaky tests detected' empty state", async ({ page }) => {
    await page.goto("/flaky");
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });

    const empty = page.locator(".empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/No flaky tests detected/i);
    // It's the true-empty state, not the filtered-empty one (which only
    // appears when a search/suite narrows a non-empty set).
    await expect(page.locator(".empty.filtered-empty")).toHaveCount(0);

    // No table, no summary strip, no error.
    await expect(page.locator("tr.flaky-row")).toHaveCount(0);
    await expect(page.locator(".summary")).toHaveCount(0);
    await expect(page.locator(".status-text.err")).toHaveCount(0);
  });
});
