import { expect, test, type Page } from "../fixtures/test";


/**
 * /compare — CRITICAL correctness coverage.
 *
 * The existing specs (compare.spec.ts / compare-extras.spec.ts) prove
 * the *structure* of the page: the selection card renders, a comparison
 * URL lands a header + pills, the Change CTA round-trips, and a
 * ?category= deep-link toggles a pill. What they deliberately do NOT do
 * is check that the numbers and categorisation the page shows actually
 * match the diff the backend computed. That's the trust-critical half:
 * /compare is a PR-review surface, so a pill that over/under-counts, a
 * category filter that leaks the wrong rows, or an added/removed test
 * rendered on the wrong side would quietly mislead a reviewer about
 * what a change did to the suite.
 *
 * These tests pin the page against the backend's own /compare response
 * (fetched in-band with the worker admin's token), so they assert real
 * correctness invariants — never hard-coded seed values, which vary per
 * tenant because the seed randomises per-run outcomes. Invariants
 * covered:
 *
 *   1. Summary pills are faithful to the backend: the "All" count equals
 *      the comparison total, every non-All pill's count equals the
 *      backend summary for that category, and the pills sum to All.
 *   2. Category filter is exact: clicking a pill (and the ?category=
 *      deep-link) renders exactly the rows of that category — no leak,
 *      no drop — and the per-file section counts partition that subset.
 *   3. Full URL state round-trips on LOAD: a deep-link carrying
 *      ?a&b&category re-opens the same comparison filtered to the same
 *      category, and survives a reload.
 *   4. added/removed rows render the missing side as the "—" placeholder
 *      (a removed test has no B side; an added test has no A side) — the
 *      visual signal a reviewer reads to see a test appeared/disappeared.
 *   5. Cross-tenant isolation: deep-linking another org's run IDs must
 *      render the error state, never that org's diff.
 *   6. A run paired with itself is an all-"unchanged" diff (the backend's
 *      identity case) — every row categorised unchanged, none failing.
 *
 * Read-only against the per-worker seeded tenant; no shared state mutated.
 */

const API = "http://localhost:3000";

type Side = { id: number; status: string; duration_ms: number; error_message: string | null } | null;
type Entry = {
  key: string;
  file_path: string;
  title: string;
  category: string;
  a: Side;
  b: Side;
  duration_delta: number | null;
};
type CompareResult = {
  run_a: { id: number };
  run_b: { id: number };
  summary: Record<string, number>;
  comparisons: Entry[];
};

/** Worker admin bearer token from localStorage (set by globalSetup sign-in). */
async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  expect(t, "expected a stored bt_token for the worker admin").toBeTruthy();
  return t;
}

/**
 * Pick the newest two runs of a suite and return them together with the
 * backend's computed comparison. We scan every suite that has ≥2 runs
 * and prefer the one whose diff spans the most categories — that gives
 * the filter/grouping assertions real variety to bite on. Falls back to
 * any ≥2-run suite if none is multi-category. Returns the raw backend
 * result so the UI can be checked against it.
 */
async function pickComparison(page: Page): Promise<{ a: number; b: number; suite: string; result: CompareResult }> {
  await page.goto("/dashboard");
  const t = await token(page);
  const picked = await page.evaluate(
    async ({ api, tok }) => {
      const headers = { Authorization: `Bearer ${tok}` };
      const runsRes = await fetch(`${api}/runs?limit=200`, { headers });
      if (!runsRes.ok) return null;
      const body = await runsRes.json();
      const bySuite = new Map<string, Array<{ id: number; created_at: string }>>();
      for (const r of body.runs as Array<{ id: number; suite_name: string; created_at: string }>) {
        const arr = bySuite.get(r.suite_name) ?? [];
        arr.push({ id: r.id, created_at: r.created_at });
        bySuite.set(r.suite_name, arr);
      }
      let best: { a: number; b: number; suite: string; result: any; categories: number } | null = null;
      for (const [suite, arr] of bySuite) {
        if (arr.length < 2) continue;
        arr.sort((x, y) => y.created_at.localeCompare(x.created_at));
        const a = arr[1].id;
        const b = arr[0].id;
        const cmpRes = await fetch(`${api}/compare?a=${a}&b=${b}`, { headers });
        if (!cmpRes.ok) continue;
        const result = await cmpRes.json();
        const categories = Object.keys(result.summary ?? {}).length;
        if (
          result.comparisons.length > 0 &&
          (best === null || categories > best.categories)
        ) {
          best = { a, b, suite, result, categories };
        }
      }
      return best;
    },
    { api: API, tok: t },
  );
  expect(picked, "seed should have a suite with 2+ runs and a non-empty diff").toBeTruthy();
  return { a: picked!.a, b: picked!.b, suite: picked!.suite, result: picked!.result as CompareResult };
}

/** Fetch a single comparison's backend result for a known a/b pair. */
async function fetchCompareResult(page: Page, a: number, b: number): Promise<CompareResult> {
  const t = await token(page);
  return page.evaluate(
    async ({ api, tok, a, b }) => {
      const res = await fetch(`${api}/compare?a=${a}&b=${b}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`compare ${a},${b} -> ${res.status}`);
      return res.json();
    },
    { api: API, tok: t, a, b },
  );
}

test.describe("/compare — summary pills are faithful to the backend diff", () => {

  test("All-pill count equals the comparison total and the category pills sum to it", async ({ page }) => {
    const { a, b, result } = await pickComparison(page);
    await page.goto(`/compare?a=${a}&b=${b}`);
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();

    const total = result.comparisons.length;

    // The "All" pill's count must equal the backend total — not an
    // off-by-one or a stale count from a previous comparison.
    const allCount = await page
      .locator(".summary-pill", { hasText: /^All\s/ })
      .locator(".pill-count")
      .innerText();
    expect(Number(allCount), "All pill count == backend comparisons total").toBe(total);

    // Each rendered non-All pill must match its backend summary count,
    // and there must be exactly one pill per non-zero category.
    const expectedCategories = Object.entries(result.summary)
      .filter(([, n]) => n > 0)
      .map(([cat]) => cat);

    const renderedPillClasses = await page
      .locator(".summary-pill:not(:first-child)")
      .evaluateAll((els) =>
        (els as HTMLElement[]).map((el) => ({
          cls: Array.from(el.classList).find((c) => c !== "summary-pill" && c !== "active") ?? "",
          count: Number(el.querySelector(".pill-count")?.textContent ?? "NaN"),
        })),
      );

    expect(
      renderedPillClasses.map((p) => p.cls).sort(),
      "one pill per non-zero backend category",
    ).toEqual(expectedCategories.sort());

    for (const { cls, count } of renderedPillClasses) {
      expect(count, `pill "${cls}" count matches backend summary`).toBe(result.summary[cls]);
    }

    // And the category counts sum back to the All total (no orphan rows).
    const summed = renderedPillClasses.reduce((acc, p) => acc + p.count, 0);
    expect(summed, "category pill counts sum to the All total").toBe(total);
  });
});

test.describe("/compare — category filter renders exactly that category's rows", () => {

  test("clicking a category pill shows exactly its rows, grouped per file", async ({ page }) => {
    const { a, b, result } = await pickComparison(page);
    await page.goto(`/compare?a=${a}&b=${b}`);
    await expect(page.locator(".summary-bar")).toBeVisible({ timeout: 15_000 });

    // Choose the category with the most rows so the assertion has the
    // most to catch — deterministic given the backend result.
    const [targetCat, expectedRows] = Object.entries(result.summary).sort(
      (x, y) => y[1] - x[1],
    )[0];
    expect(expectedRows, "chosen category should have ≥1 row").toBeGreaterThan(0);

    const pill = page.locator(`.summary-pill.${targetCat}`);
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveClass(/active/);
    // URL reflects the active filter.
    await expect(page).toHaveURL(new RegExp(`category=${targetCat}(?:&|$)`));

    // Every rendered compare-row must carry the chosen category, and the
    // total rendered count must equal the backend count for it — no leak
    // of other categories, no dropped rows.
    const rows = page.locator(".compare-row");
    await expect(rows).toHaveCount(expectedRows);
    const wrongCategoryRows = await page
      .locator(`.compare-row:not(.${targetCat})`)
      .count();
    expect(wrongCategoryRows, "no rows of a different category leak through the filter").toBe(0);

    // The per-file sections must partition the filtered rows exactly:
    // the sum of each section's stated test count equals the row total.
    const fileCounts = await page
      .locator(".file-section .file-count")
      .evaluateAll((els) =>
        (els as HTMLElement[]).map((el) => Number((el.textContent ?? "").match(/\d+/)?.[0] ?? "NaN")),
      );
    const fileSum = fileCounts.reduce((acc, n) => acc + n, 0);
    expect(fileSum, "per-file section counts sum to the filtered row total").toBe(expectedRows);
  });
});

test.describe("/compare — full URL state round-trips on load + reload", () => {

  test("?a&b&category deep-link restores the comparison filtered to that category, surviving reload", async ({
    page,
  }) => {
    const { a, b, result } = await pickComparison(page);
    const [targetCat, expectedRows] = Object.entries(result.summary).sort(
      (x, y) => y[1] - x[1],
    )[0];

    // Deep-link straight into a filtered comparison (the inverse of the
    // "click writes the URL" path the extras spec covers).
    await page.goto(`/compare?a=${a}&b=${b}&category=${targetCat}`);
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 15_000 });

    const pill = page.locator(`.summary-pill.${targetCat}`);
    await expect(pill, "deep-linked category pill is active on load").toHaveClass(/active/);
    await expect(page.locator(".compare-row")).toHaveCount(expectedRows);

    // Reload — the URL is the source of truth, so the same filtered view
    // must come back rather than resetting to "All".
    await page.reload();
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`.summary-pill.${targetCat}`), "filter survives reload").toHaveClass(
      /active/,
    );
    await expect(page.locator(".compare-row")).toHaveCount(expectedRows);
  });
});

test.describe("/compare — added/removed rows render the missing side as the placeholder", () => {

  test("a removed test shows '—' on the B side; an added test shows '—' on the A side", async ({
    page,
  }) => {
    const { a, b, result } = await pickComparison(page);
    await page.goto(`/compare?a=${a}&b=${b}`);
    await expect(page.locator(".summary-bar")).toBeVisible({ timeout: 15_000 });

    // Drive whichever of added/removed the picked diff actually has; at
    // least one is present in any non-trivial seed pair, but guard so a
    // pair that happens to have neither skips cleanly without masking.
    const hasRemoved = (result.summary.removed ?? 0) > 0;
    const hasAdded = (result.summary.added ?? 0) > 0;
    expect(
      hasRemoved || hasAdded,
      "picked comparison should contain at least one added or removed test",
    ).toBeTruthy();

    if (hasRemoved) {
      await page.locator(".summary-pill.removed").click();
      await expect(page.locator(".summary-pill.removed")).toHaveClass(/active/);
      const firstRow = page.locator(".compare-row.removed").first();
      await expect(firstRow).toBeVisible();
      // A removed test exists on A but not B → A side has a real status
      // dot, B side renders the empty placeholder.
      await expect(firstRow.locator(".compare-status-a .status-dot")).toBeVisible();
      await expect(firstRow.locator(".compare-status-b .status-label.empty")).toHaveText("—");
    }

    if (hasAdded) {
      await page.locator(".summary-pill.added").click();
      await expect(page.locator(".summary-pill.added")).toHaveClass(/active/);
      const firstRow = page.locator(".compare-row.added").first();
      await expect(firstRow).toBeVisible();
      // An added test exists on B but not A → A side is the placeholder,
      // B side has a real status dot.
      await expect(firstRow.locator(".compare-status-a .status-label.empty")).toHaveText("—");
      await expect(firstRow.locator(".compare-status-b .status-dot")).toBeVisible();
    }
  });
});

test.describe("/compare — comparing a run with itself has no transitions", () => {

  test("?a=X&b=X yields only unchanged / still_failing — no regression, fix, add or remove", async ({
    page,
  }) => {
    const { a } = await pickComparison(page);
    const selfResult = await fetchCompareResult(page, a, a);

    // Identity case: same run on both sides. Every test maps to itself
    // with an identical status, so the diff can contain no *transition*:
    // a passing/skipped test is "unchanged" and a failing one stays
    // "still_failing" (failed→failed is caught before the same-status
    // fallthrough — that branch ordering is the engine's behaviour). The
    // anchor invariant is that NO regression/fixed/added/removed/changed/
    // newly_* category can ever appear when a == b.
    expect(selfResult.comparisons.length, "a non-empty run compared with itself").toBeGreaterThan(0);
    const transitions = selfResult.comparisons.filter(
      (c) => c.category !== "unchanged" && c.category !== "still_failing",
    );
    expect(transitions, "self-comparison produces no diff transitions").toEqual([]);

    await page.goto(`/compare?a=${a}&b=${a}`);
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 15_000 });

    // Both header cards point at the same run.
    await expect(page.locator(`.compare-header a[href="/runs/${a}"]`)).toHaveCount(2);

    // The only category pills that can appear are unchanged / still_failing
    // (whichever the run's own pass/fail mix produces); transition pills
    // must be absent entirely.
    for (const cat of ["regression", "fixed", "added", "removed", "changed", "newly_skipped", "newly_failing_from_skipped"]) {
      await expect(page.locator(`.summary-pill.${cat}`), `no ${cat} pill on a self-compare`).toHaveCount(0);
    }
    const renderedPills = await page
      .locator(".summary-pill:not(:first-child)")
      .evaluateAll((els) =>
        (els as HTMLElement[]).map(
          (el) => Array.from(el.classList).find((c) => c !== "summary-pill" && c !== "active") ?? "",
        ),
      );
    expect(
      renderedPills.every((c) => c === "unchanged" || c === "still_failing"),
      "only unchanged / still_failing pills render on a self-compare",
    ).toBeTruthy();
  });
});

test.describe("/compare — cross-tenant isolation", () => {

  test("deep-linking another org's run IDs renders the error state, not their diff", async ({
    page,
  }) => {
    // Pick a real comparison on THIS worker tenant, then find run IDs
    // that belong to a different org and confirm the page refuses them.
    // The compare API resolves runs under the caller's RLS, so foreign
    // run IDs come back 404 and the page must surface the error message
    // rather than rendering a header for runs the viewer can't see.
    const { a, b } = await pickComparison(page);
    const t = await token(page);

    // Find two ids that are NOT visible to this tenant by probing the
    // backend: scan a wide id range and keep the first two that 404 on
    // the runs API (i.e. exist for some other org or not at all — either
    // way, not ours). Deterministic: we assert the page's response to
    // ids the backend will not serve us.
    const foreign = await page.evaluate(
      async ({ api, tok, mine }) => {
        const headers = { Authorization: `Bearer ${tok}` };
        const found: number[] = [];
        for (let id = 1; id <= 400 && found.length < 2; id++) {
          if (mine.includes(id)) continue;
          const res = await fetch(`${api}/runs/${id}`, { headers });
          if (res.status === 404) found.push(id);
        }
        return found;
      },
      { api: API, tok: t, mine: [a, b] },
    );
    expect(foreign.length, "expected to find run IDs this tenant cannot see").toBe(2);

    await page.goto(`/compare?a=${foreign[0]}&b=${foreign[1]}`);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 15_000 });

    // The page must show the error message and NOT a comparison header
    // for runs the viewer has no access to.
    await expect(page.locator(".error-msg")).toBeVisible();
    await expect(page.locator(".compare-header")).toHaveCount(0);
  });
});
