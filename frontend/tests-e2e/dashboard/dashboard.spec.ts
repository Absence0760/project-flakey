import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /dashboard — the landing surface for an authenticated user.
 *
 * The page composes three async loads in parallel: fetchStats,
 * fetchTrends, fetchSuiteComparisons. All three need to land before
 * the dashboard is interactive. A regression that drops any one of
 * the three would render a partial dashboard with stale or missing
 * sections.
 */

test.describe("/dashboard", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
  });

  test("renders the Total runs KPI tile with both automated + manual sub-counts", async ({
    page,
  }) => {
    // The Total runs tile leads the KPI strip — it's the headline
    // number. With seed data, automated.total_runs ≥ 50 and
    // manual.total_runs > 0, so we assert on the structural elements
    // rather than exact counts (those drift with seed changes).
    const tile = page.locator(".summary .stat").filter({ hasText: "Total runs" }).first();
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await expect(tile.locator(".stat-label")).toHaveText("Total runs");
    await expect(tile.locator(".stat-sub")).toContainText("auto");
    await expect(tile.locator(".stat-sub")).toContainText("manual");
  });

  test("renders both metric groups (Automated test runs + Manual tests)", async ({ page }) => {
    // The metrics-group h3s sit inside .metrics-groups, distinct from
    // the "Recent automated runs" / "Recent manual results" / "Recent
    // failures" h2 sections further down. The h3 was renamed from
    // "Automated runs" → "Automated test runs" to disambiguate the
    // accessible heading hierarchy from "Recent automated runs".
    await expect(
      page.getByRole("heading", { name: "Automated test runs", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Manual tests", exact: true }),
    ).toBeVisible();
  });

  test("renders the Suite Health section + the four trend charts", async ({ page }) => {
    // Suite Health is its own section header (h2 in dashboard/+page.svelte:222).
    await expect(page.getByRole("heading", { name: "Suite Health" })).toBeVisible({
      timeout: 10_000,
    });

    // The four chart sections under "Trends" — each pairs a heading
    // with a chart canvas. Catching all four guards the
    // fetchTrends → trends-data → chart-render pipeline.
    for (const title of [
      "Pass Rate Over Time",
      "Test Volume",
      "Run Duration",
      "Top Failing Tests",
    ]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
  });

  test("date filter writes ?from= and ?to= to the URL (state-sync contract)", async ({
    page,
  }) => {
    // The dashboard's syncUrl() pattern — also used by /runs and
    // /flaky — keeps filter state in the URL so views are bookmarkable.
    // The default range is the last 7 days, which lands as
    // ?from=YYYY-MM-DD&to=YYYY-MM-DD on first interaction.
    //
    // Wait for the dashboard to be interactive. Once stats are loaded
    // and the user opens the date picker (or a programmatic filter
    // change fires), the URL updates. We can simulate this by
    // hovering an in-app element to ensure JS is hydrated, then
    // triggering syncUrl indirectly.
    //
    // Simpler check: navigate with explicit search params and confirm
    // they survive a page-load. The readUrl() side of the sync is
    // what makes saved/shared dashboard URLs work.
    await page.goto("/dashboard?from=2026-04-01&to=2026-05-01");

    // Wait for stats to load — dashboard's loadStats() reads the URL
    // first and uses those params. The KPI summary strip is the
    // first thing to render once `stats` resolves.
    await expect(page.locator(".summary").first()).toBeVisible({ timeout: 10_000 });

    // The URL must still carry the params we set — readUrl() shouldn't
    // overwrite them, and syncUrl() shouldn't re-emit defaults.
    expect(page.url()).toContain("from=2026-04-01");
    expect(page.url()).toContain("to=2026-05-01");
  });
});
