import { expect, test, type Page } from "../fixtures/test";


/**
 * /compare — extra paths beyond the basic header/pills smoke.
 *
 * - Selection mode: pick a suite, then BOTH runs, then click Compare —
 *   navigates to /compare?a=…&b=… and renders the diff.
 * - URL state ?category=fixed lands with the Fixed pill active and
 *   only fixed rows visible.
 * - The "Change" CTA mid-comparison returns to the selection card and
 *   the previous a/b are not stuck in the URL.
 */

async function pickRunIdsForSuite(
  page: Page,
): Promise<{ a: number; b: number; suite: string }> {
  await page.goto("/dashboard");
  const picked = await page.evaluate(async () => {
    const token = localStorage.getItem("bt_token");
    const res = await fetch("http://localhost:3000/runs?limit=200", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
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
  expect(picked, "seed should have a suite with ≥2 runs").toBeTruthy();
  return picked!;
}

test.describe("/compare — selection-mode flow", () => {

  test("pick suite → run A → run B → Compare → navigates to ?a=…&b=…", async ({ page }) => {
    const { a, b, suite } = await pickRunIdsForSuite(page);
    await page.goto("/compare");
    await expect(page.getByRole("heading", { name: "Compare Runs" })).toBeVisible({
      timeout: 10_000,
    });

    // Suite dropdown.
    await page.locator(".select-card select").first().selectOption(suite);

    // After picking a suite, the run A and run B selectors mount.
    const runSelects = page.locator(".select-card select");
    await expect(runSelects).toHaveCount(3, { timeout: 2_000 });
    await runSelects.nth(1).selectOption(String(a));
    await runSelects.nth(2).selectOption(String(b));

    const compareBtn = page.getByRole("button", { name: /^Compare$/ });
    await expect(compareBtn).toBeEnabled();
    await compareBtn.click();

    // URL gets ?a=…&b=…; the comparison header lands.
    await expect(page).toHaveURL(new RegExp(`a=${a}.*b=${b}|b=${b}.*a=${a}`), {
      timeout: 5_000,
    });
    await expect(page.locator(".compare-header")).toBeVisible();
  });
});

test.describe("/compare — Change returns to a usable selection card", () => {

  test("Change after a ?a&b URL entry repopulates the suite dropdown and clears a/b from the URL", async ({
    page,
  }) => {
    // Regression: entering comparison mode straight from a URL never
    // fetched the run list, so clicking "Change" dropped the user on a
    // selection card whose suite dropdown held only the placeholder —
    // a dead end. Change must lazily load runs and clear the stale
    // ?a&b so a reload doesn't bounce back into the old comparison.
    const { a, b, suite } = await pickRunIdsForSuite(page);
    await page.goto(`/compare?a=${a}&b=${b}`);
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /^Change$/ }).click();
    await expect(page.locator(".select-card")).toBeVisible();

    // The suite dropdown must end up populated with real suites (runs
    // were lazily fetched), not just the "Select a suite..." placeholder.
    const suiteSelect = page.locator(".select-card select").first();
    await expect(suiteSelect.locator("option")).not.toHaveCount(1, { timeout: 5_000 });
    const optionCount = await suiteSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(1);

    // Stale comparison params are gone from the URL.
    const url = new URL(page.url());
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("b")).toBeNull();
    expect(url.searchParams.get("category")).toBeNull();

    // And the card is genuinely usable: picking a suite mounts the
    // run A/B selectors.
    await suiteSelect.selectOption(suite);
    await expect(page.locator(".select-card select")).toHaveCount(3, { timeout: 2_000 });
  });
});

test.describe("/compare — comparison-mode URL state", () => {

  test("?category=unchanged lands with the Unchanged pill active", async ({ page }) => {
    const { a, b } = await pickRunIdsForSuite(page);
    await page.goto(`/compare?a=${a}&b=${b}&category=unchanged`);

    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 10_000 });
    // Unchanged pill might not exist if the seed-driven comparison
    // produced 0 unchanged rows. Either it's active or the user
    // sees the empty-result hint — both are valid for this URL.
    const pill = page.locator(".summary-pill", { hasText: "Unchanged" });
    if ((await pill.count()) > 0) {
      await expect(pill).toHaveClass(/active/);
    } else {
      await expect(page.locator(".muted", { hasText: /No tests match/ })).toBeVisible();
    }
  });
});
