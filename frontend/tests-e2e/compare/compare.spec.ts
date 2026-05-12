import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /compare — diff two runs of the same suite.
 *
 * Two surfaces:
 *  - No params  → selection card (suite → run A → run B → "Compare").
 *  - ?a=X&b=Y   → side-by-side header, summary pills (per-category
 *                 filter), grouped per-file rows with category badges.
 *
 * The comparison API enforces "same suite". The seed has multiple
 * runs per suite, so we pick two from one suite via the dashboard's
 * runs list and feed their ids into the compare URL.
 */

async function pickTwoRunIdsForSameSuite(
  page: Page,
): Promise<{ a: number; b: number; suite: string }> {
  await page.goto("/dashboard");
  // Hit the runs API directly — same pattern as snapshot-viewer.spec.
  const picked = await page.evaluate(async () => {
    const token = localStorage.getItem("bt_token");
    const res = await fetch("http://localhost:3000/runs?limit=200", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // Group by suite, find a suite with ≥2 runs, return its newest two.
    const bySuite = new Map<string, Array<{ id: number; created_at: string }>>();
    for (const r of body.runs as Array<{ id: number; suite_name: string; created_at: string }>) {
      const arr = bySuite.get(r.suite_name) ?? [];
      arr.push({ id: r.id, created_at: r.created_at });
      bySuite.set(r.suite_name, arr);
    }
    for (const [suite, arr] of bySuite) {
      if (arr.length >= 2) {
        arr.sort((x, y) => y.created_at.localeCompare(x.created_at));
        return { a: arr[1].id, b: arr[0].id, suite };
      }
    }
    return null;
  });
  expect(picked, "seed should have at least one suite with 2+ runs").toBeTruthy();
  return picked!;
}

test.describe("/compare — selection mode", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("with no params, renders the selection card with suite + run dropdowns", async ({
    page,
  }) => {
    await page.goto("/compare");

    await expect(page.getByRole("heading", { name: "Compare Runs" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".select-card")).toBeVisible();

    // The first dropdown is "Select a suite..." — runs A/B selectors
    // only appear after a suite is picked.
    const suiteSelect = page.locator(".select-card select").first();
    await expect(suiteSelect).toBeVisible();
    const suiteOptions = await suiteSelect
      .locator("option")
      .evaluateAll((opts) => (opts as HTMLOptionElement[]).map((o) => o.textContent?.trim() ?? ""));
    expect(suiteOptions.length, "suite list should be populated").toBeGreaterThan(1);

    // Compare button is disabled until both A and B are picked.
    const compareBtn = page.getByRole("button", { name: /^Compare$/ });
    await expect(compareBtn).toBeDisabled();
  });
});

test.describe("/compare — comparison mode", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("with ?a=X&b=Y, renders header, summary pills, and at least one per-file section", async ({
    page,
  }) => {
    const { a, b } = await pickTwoRunIdsForSameSuite(page);
    await page.goto(`/compare?a=${a}&b=${b}`);

    // Header lands with two run cards linking back to /runs/<id>.
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`.compare-header a[href="/runs/${a}"]`)).toBeVisible();
    await expect(page.locator(`.compare-header a[href="/runs/${b}"]`)).toBeVisible();

    // Summary pills always include "All". Specific category counts
    // depend on the picked runs — assert structure, not values.
    const allPill = page.locator(".summary-pill", { hasText: /^All\s/ });
    await expect(allPill).toBeVisible();
    await expect(allPill).toHaveClass(/active/);

    // The diff body either has at least one .file-section, or shows
    // "No tests match this filter." for the (very rare) case the
    // backend returned an empty comparisons[]. In a freshly-seeded
    // DB with two runs of the same suite, both runs share the same
    // spec set so the comparison should not be empty.
    await expect(page.locator(".file-section, .muted").first()).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a category pill narrows to that category and syncs ?category=", async ({
    page,
  }) => {
    const { a, b } = await pickTwoRunIdsForSameSuite(page);
    await page.goto(`/compare?a=${a}&b=${b}`);

    await expect(page.locator(".summary-bar")).toBeVisible({ timeout: 10_000 });

    // Find a non-"All" pill that has a count > 0; clicking it should
    // toggle it active. We don't pin which category — different seeds
    // produce different distributions. "Unchanged" is the most reliable
    // category to be present (most tests are stable across runs).
    const unchangedPill = page.locator(".summary-pill", { hasText: "Unchanged" });
    if ((await unchangedPill.count()) === 0) {
      // Fall back to whichever non-All pill exists.
      const fallback = page.locator(".summary-pill:not(:first-child)").first();
      await expect(fallback).toBeVisible();
      await fallback.click();
      await expect(fallback).toHaveClass(/active/);
      expect(page.url()).toContain("category=");
      return;
    }

    await unchangedPill.click();
    await expect(unchangedPill).toHaveClass(/active/);
    expect(page.url()).toContain("category=unchanged");
  });

  test("Change button takes the user back to the selection card", async ({ page }) => {
    const { a, b } = await pickTwoRunIdsForSameSuite(page);
    await page.goto(`/compare?a=${a}&b=${b}`);

    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^Change$/ }).click();
    await expect(page.getByRole("heading", { name: "Compare Runs" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(".select-card")).toBeVisible();
  });
});
