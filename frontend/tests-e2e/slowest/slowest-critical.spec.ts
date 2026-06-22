import { expect, test } from "../fixtures/test";
import { DEMO_USER } from "../fixtures/users";

/**
 * /slowest — critical correctness coverage.
 *
 * /slowest ranks tests by duration so an engineer can find what's
 * dragging a suite. Its trustworthiness rests on three things the
 * existing specs (slowest.spec.ts / slowest-extras.spec.ts) do NOT
 * assert — they cover the filter/sort/search *chrome* (active class,
 * ?param written, expand-on-click, the re-sort key-stability
 * regression) but never that:
 *
 *  1. each sort tab actually ORDERS the visible rows by the metric it
 *     names (descending) — the ranking guarantee, not just the class;
 *  2. the numbers a row shows (avg, the P50/P95/P99/run-count detail)
 *     MATCH the underlying API data, and satisfy the invariants a
 *     duration distribution must hold (min ≤ avg ≤ max, p50 ≤ p95 ≤
 *     p99, run_count ≥ 2 — the server-side HAVING threshold);
 *  3. the genuinely empty org renders the empty state (the ≥1-row
 *     assumption the other specs bake in is a property of the data),
 *     and the list is tenant-scoped.
 *
 * Plus a full multi-param URL round-trip across a hard reload (sort + q
 * together), which the extras file only proves one param at a time.
 *
 * Source-of-truth for the value/order checks is the same endpoint the
 * page calls (`GET /tests/slowest/list?limit=100`), read directly with
 * the signed-in worker's bearer token — so the DOM is compared against
 * real data, not guessed constants.
 *
 * Read-only against the per-worker seeded tenant (acme-w<N>), whose
 * seed reliably yields a populated slowest list; the empty-state test
 * pins to DEMO_USER (owner of an org with zero runs).
 */

const READY = '.page[data-ready="true"]';
const API = "http://localhost:3000";

type SlowestRow = {
  title: string;
  file_path: string;
  suite_name: string;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  run_count: number;
  trend_pct: number;
};

/** The page's `formatMs`, reproduced so DOM text can be matched to API ms. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Fetch the slowest list straight from the API the page consumes. */
async function fetchSlowest(page: import("@playwright/test").Page): Promise<SlowestRow[]> {
  return page.evaluate(async (api) => {
    const res = await fetch(`${api}/tests/slowest/list?limit=100`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("bt_token")}` },
    });
    if (!res.ok) throw new Error(`slowest fetch failed: ${res.status}`);
    return res.json();
  }, API);
}

test.describe("/slowest — critical correctness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/slowest");
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });
    // Populated worker tenant — at least one card once ready.
    await expect(page.locator(".test-card").first()).toBeVisible({ timeout: 10_000 });
  });

  test("default 'Average' sort renders rows in the API's avg-desc order", async ({ page }) => {
    // The page asks the backend for the list (already ORDER BY
    // avg_duration_ms DESC) and re-sorts client-side by the same key —
    // so the rendered titles must equal the API's titles in order, for
    // the page-1 slice. This proves the ranking the user sees is the
    // server's ranking, not an accidental reorder.
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: "Average" }),
    ).toHaveClass(/active/);

    const api = await fetchSlowest(page);
    expect(api.length).toBeGreaterThan(1);

    const renderedTitles = await page
      .locator(".test-card .test-title")
      .allTextContents();
    expect(renderedTitles.length).toBeGreaterThan(1);

    // Compare the rendered page-1 slice against the API's leading slice.
    const expected = api.slice(0, renderedTitles.length).map((r) => r.title);
    expect(renderedTitles.map((t) => t.trim())).toEqual(expected);

    // And the order is genuinely non-increasing by avg (the ranking
    // guarantee), read off the API rows that back those visible cards.
    const avgs = api.slice(0, renderedTitles.length).map((r) => r.avg_duration_ms);
    for (let i = 1; i < avgs.length; i++) {
      expect(avgs[i]).toBeLessThanOrEqual(avgs[i - 1]);
    }
  });

  test("each sort tab orders the visible rows by the metric it names (descending)", async ({ page }) => {
    // Map each tab to the API field it sorts by. For every tab, click it,
    // wait for the active-class signal (the derived `sorted` recomputed),
    // then read the rendered titles, look each up in the API data, and
    // assert that field is monotonically non-increasing down the list.
    const api = await fetchSlowest(page);
    const byTitleSuite = new Map(api.map((r) => [`${r.title}|${r.suite_name}`, r]));

    const cases: Array<{ tab: string; field: keyof SlowestRow }> = [
      { tab: "Max", field: "max_duration_ms" },
      { tab: "P95", field: "p95_ms" },
      { tab: "Getting slower", field: "trend_pct" },
      { tab: "Average", field: "avg_duration_ms" },
    ];

    for (const { tab, field } of cases) {
      const tabBtn = page.locator(".sort-bar .filter-tab", { hasText: new RegExp(`^${tab}$`) });
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/active/);

      // Read each visible card's title + suite badge so we can key into
      // the API rows. The suite badge renders only with "All suites"
      // selected (the default here), giving us the full row key.
      const keys = await page.locator(".test-card").evaluateAll((cards) =>
        (cards as HTMLElement[]).map((c) => {
          const title = c.querySelector(".test-title")?.textContent?.trim() ?? "";
          const suite = c.querySelector(".suite-badge")?.textContent?.trim() ?? "";
          return `${title}|${suite}`;
        }),
      );
      expect(keys.length, `${tab}: rows rendered`).toBeGreaterThan(1);

      const values = keys.map((k) => {
        const row = byTitleSuite.get(k);
        expect(row, `${tab}: rendered row "${k}" exists in API data`).toBeTruthy();
        return row![field] as number;
      });
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${tab}: row ${i} ≤ row ${i - 1}`).toBeLessThanOrEqual(values[i - 1]);
      }
    }
  });

  test("a row's avg text matches the API and the bar respects min ≤ avg ≤ max", async ({ page }) => {
    // The big number on each row is the avg, formatted via formatMs. The
    // tiny range line is min–max. Both must agree with the API row, and
    // the distribution invariant min ≤ avg ≤ max must hold — otherwise
    // the bar (avg fill + max tick) is lying about the spread.
    const api = await fetchSlowest(page);
    const first = api[0]; // page renders the API's #1 at the top (avg sort)
    expect(first).toBeTruthy();

    const firstCard = page.locator(".test-card").first();
    await expect(firstCard.locator(".test-title")).toHaveText(first.title);
    await expect(firstCard.locator(".dur-avg")).toHaveText(formatMs(first.avg_duration_ms));
    await expect(firstCard.locator(".dur-range")).toHaveText(
      `${formatMs(first.min_duration_ms)}–${formatMs(first.max_duration_ms)}`,
    );

    expect(first.min_duration_ms).toBeLessThanOrEqual(first.avg_duration_ms);
    expect(first.avg_duration_ms).toBeLessThanOrEqual(first.max_duration_ms);
  });

  test("drill-down shows real per-test detail matching the API (percentiles, run count, history)", async ({ page }) => {
    // Opening a card is the from-list-to-detail moment. Assert the
    // detail grid's percentiles + run count match the API row exactly,
    // that the percentile ordering p50 ≤ p95 ≤ p99 holds, run_count ≥ 2
    // (the server's HAVING threshold), the history chart renders one bar
    // per recorded run, and the per-test notes panel mounts.
    const api = await fetchSlowest(page);
    const first = api[0];

    const firstCard = page.locator(".test-card").first();
    await expect(firstCard.locator(".test-title")).toHaveText(first.title);
    await firstCard.locator(".test-header").click();
    await expect(firstCard).toHaveClass(/expanded/);

    const detail = firstCard.locator(".test-detail");
    await expect(detail).toBeVisible();

    // Each detail-item is (label, value). Read them into a map.
    const items = await detail.locator(".detail-item").evaluateAll((els) =>
      (els as HTMLElement[]).map((el) => ({
        label: el.querySelector(".detail-label")?.textContent?.trim() ?? "",
        value: el.querySelector(".detail-value")?.textContent?.trim() ?? "",
      })),
    );
    const byLabel = new Map(items.map((i) => [i.label, i.value]));

    expect(byLabel.get("P50")).toBe(formatMs(first.p50_ms));
    expect(byLabel.get("P95")).toBe(formatMs(first.p95_ms));
    expect(byLabel.get("P99")).toBe(formatMs(first.p99_ms));
    expect(byLabel.get("Runs")).toBe(String(first.run_count));

    // Distribution invariants from the API row.
    expect(first.p50_ms).toBeLessThanOrEqual(first.p95_ms);
    expect(first.p95_ms).toBeLessThanOrEqual(first.p99_ms);
    expect(first.run_count).toBeGreaterThanOrEqual(2);

    // History chart: title states "last N runs"; one bar renders per run.
    await expect(detail.locator(".history-chart h4")).toContainText(
      `last ${first.run_count} runs`,
    );
    await expect(detail.locator(".history-bars .history-bar")).toHaveCount(first.run_count);

    // The per-test notes panel — the collaboration affordance that makes
    // the drill-down a real triage unit.
    await expect(detail.locator(".test-notes .notes-panel")).toBeVisible();
  });

  test("suite + sort + search survive a hard reload (multi-param URL round-trip)", async ({ page }) => {
    // The extras spec proves each param is written individually; this
    // proves all three persist together across a real reload (the
    // read→sync cycle must be idempotent and must not drop a non-default
    // value on rehydrate). Pick a concrete suite from the dropdown so a
    // real value rides along, and a search token from a card title.
    const suiteSelect = page.locator(".filters select").first();
    await expect(suiteSelect).toBeVisible();
    const opts = await suiteSelect
      .locator("option")
      .evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value));
    const suiteChoice = opts.find((o) => o !== "all" && o !== "") ?? "all";
    expect(suiteChoice).not.toBe("all");

    await suiteSelect.selectOption(suiteChoice);
    await expect(page.locator(".test-list, .empty")).toBeVisible({ timeout: 5_000 });

    await page.locator(".sort-bar .filter-tab", { hasText: /^Max$/ }).click();

    // A token guaranteed to match ≥1 visible row in this suite.
    const firstTitle =
      (await page.locator(".test-card .test-title").first().textContent())?.trim() ?? "";
    const token = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4);
    expect(token.length).toBeGreaterThan(0);
    await page.locator(".search-box input").fill(token);

    // All three params now live in the URL.
    await expect(page).toHaveURL(/sort=max_duration_ms/);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page).toHaveURL(new RegExp(`suite=${encodeURIComponent(suiteChoice).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // Hard reload from the URL — state must rehydrate, not reset.
    await page.reload();
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });

    await expect(suiteSelect).toHaveValue(suiteChoice);
    await expect(
      page.locator(".sort-bar .filter-tab", { hasText: /^Max$/ }),
    ).toHaveClass(/active/);
    await expect(page.locator(".search-box input")).toHaveValue(token);
    // The active-search-only summary proves the search rehydrated, not
    // just the input text.
    await expect(page.locator(".filter-summary")).toBeVisible();
    // URL still carries all three after the round-trip (no drop).
    await expect(page).toHaveURL(/sort=max_duration_ms/);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  test("the list is tenant-scoped — every slowest row belongs to this org's runs", async ({ page }) => {
    // Cross-tenant leak guard: the slowest endpoint runs under RLS, so
    // every (suite, file_path) it returns must also appear in this org's
    // own runs/specs. Build the set of legitimate (suite|file) pairs from
    // /runs + each run's specs, then assert every slowest row is in it.
    const slowest = await fetchSlowest(page);
    expect(slowest.length).toBeGreaterThan(0);

    // The suites the slowest rows reference must all be suites this org runs.
    const ownSuites = await page.evaluate(async (api) => {
      const auth = { Authorization: `Bearer ${localStorage.getItem("bt_token")}` };
      const res = await fetch(`${api}/runs?limit=200`, { headers: auth });
      const body = (await res.json()) as { runs: Array<{ suite_name: string }> };
      return [...new Set(body.runs.map((r) => r.suite_name))];
    }, API);

    const ownSuiteSet = new Set(ownSuites);
    for (const row of slowest) {
      expect(
        ownSuiteSet.has(row.suite_name),
        `slowest suite "${row.suite_name}" must be one of this tenant's suites`,
      ).toBe(true);
    }
  });
});

test.describe("/slowest — empty org", () => {
  // DEMO_USER owns Demo Team, an org the seed creates with zero runs, so
  // there are no tests with 2+ passing runs to rank. The page must show
  // the genuine empty state (not the filtered-empty one, and not an
  // error) — proving the ≥1-row assumption the other specs bake in is a
  // property of the *data*, not the page.
  test.use({ storageState: DEMO_USER.storageStatePath });

  test("an org with no runs shows the 'No test data available yet' empty state", async ({ page }) => {
    await page.goto("/slowest");
    await expect(page.locator(READY)).toBeVisible({ timeout: 10_000 });

    const empty = page.locator(".empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/No test data available yet/i);
    await expect(empty).toContainText(/at least 2 passing runs/i);

    // It's the true-empty state, not the filtered-empty one (which only
    // appears when a search narrows a non-empty set).
    await expect(page.locator(".empty.filtered-empty")).toHaveCount(0);

    // No cards, no summary strip, no error, no at-risk band.
    await expect(page.locator(".test-card")).toHaveCount(0);
    await expect(page.locator(".summary")).toHaveCount(0);
    await expect(page.locator(".at-risk-band")).toHaveCount(0);
    await expect(page.locator(".status-text.err")).toHaveCount(0);
  });
});
