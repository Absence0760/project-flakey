import { expect, test, type Page } from "../fixtures/test";

import { DEMO_USER } from "../fixtures/users";

/**
 * Critical, currently-untested correctness on the /dashboard landing
 * surface — the numbers an oncall trusts at a glance and the
 * interactions that change what they see.
 *
 * The existing dashboard specs (dashboard.spec.ts, dashboard-extras.spec.ts,
 * date-range-picker.spec.ts) prove the page *renders* its sections and
 * that the DateRangePicker writes ?from/?to to the URL. None of them
 * prove the trust-critical half:
 *
 *   1. The KPI tiles report the SAME numbers the backend serves — the
 *      "Total runs" / "Automated pass rate" / "Failures" headline math
 *      (totalRuns = auto+manual runs, totalFailures = auto failed +
 *      manual failed_runs) must match /stats, or the dashboard lies
 *      about the build's health.
 *
 *   2. The date filter actually CHANGES the rendered numbers — a narrow
 *      window shows fewer runs than All Time, and an empty future window
 *      collapses the KPIs to zero. The picker specs only assert URL
 *      writes; none prove the data downstream re-renders.
 *
 *   3. A pre-filtered ?from&to URL re-hydrates the page on LOAD (the
 *      readUrl side of the sync contract) so a shared/bookmarked
 *      dashboard link reproduces the same view.
 *
 *   4. Suite Health cards link into the right detail route (compare for
 *      suites with a previous run, the run otherwise) — the dashboard is
 *      a launch pad; a broken widget link is a dead end.
 *
 *   5. Per-tenant scoping — an empty org (DEMO_USER's Demo Team) shows
 *      zeroed KPIs + the explicit empty panels, never another tenant's
 *      numbers.
 *
 * Read-only against the per-worker seeded tenant except the DEMO_USER
 * block, which pins to the (separate) empty Demo Team org.
 */

const API = "http://localhost:3000";

// A window wide enough to cover the whole seed (runs go back ~60 days).
// We pin an explicit dated range rather than "All Time" because the
// dashboard's readUrl() only honours *truthy* ?from/?to — an empty
// ?from=&to= is ignored and the page falls back to its last-7-days
// default, which is never written to the URL. An explicit wide range is
// the only deterministic way to make the rendered window and our
// verification fetch agree on the full dataset.
const WIDE_FROM = "2020-01-01";
const WIDE_TO = "2099-12-31";
const WIDE_Q = `?from=${WIDE_FROM}&to=${WIDE_TO}`;
const WIDE_URL = `/dashboard${WIDE_Q}`;

/** Worker admin bearer token from localStorage (set by globalSetup sign-in). */
async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  expect(t, "expected a stored bt_token for the signed-in user").toBeTruthy();
  return t;
}

type Stats = {
  automated: { total_runs: number; total_tests: number; total_passed: number; total_failed: number; pass_rate: number };
  manual: { total_runs: number; failed_runs: number; pass_rate: number; executed: number; not_run: number };
};

/** Fetch /stats the same way the page does (current auth, same query). */
async function fetchStats(page: Page, query = ""): Promise<Stats> {
  return page.evaluate(
    async ({ api, q }) => {
      const res = await fetch(`${api}/stats${q}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("bt_token")}` },
      });
      if (!res.ok) throw new Error(`stats ${res.status}`);
      return res.json();
    },
    { api: API, q: query },
  );
}

/** Read the integer rendered in a KPI tile by its label. */
async function kpiValue(page: Page, label: string): Promise<number> {
  const tile = page.locator(".summary .stat").filter({ hasText: label }).first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  const raw = (await tile.locator(".stat-value").textContent())?.trim() ?? "";
  // Strip a trailing % (pass-rate tiles) and any thousands separators.
  return Number(raw.replace(/[%,]/g, ""));
}

test.describe("/dashboard — KPI numbers match the backend", () => {

  test("the four headline KPI tiles report the same totals /stats serves", async ({ page }) => {
    // Deep-link an explicit wide window so the page's fetch and our
    // verification fetch see the identical dataset (see WIDE_* above for
    // why an explicit range, not "All Time").
    await page.goto(WIDE_URL);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    const windowed = await fetchStats(page, WIDE_Q);
    const expectedTotalRuns = windowed.automated.total_runs + windowed.manual.total_runs;
    const expectedFailures = windowed.automated.total_failed + windowed.manual.failed_runs;

    expect(await kpiValue(page, "Total runs")).toBe(expectedTotalRuns);
    expect(await kpiValue(page, "Automated pass rate")).toBe(windowed.automated.pass_rate);
    expect(await kpiValue(page, "Failures")).toBe(expectedFailures);
    expect(await kpiValue(page, "Manual pass rate")).toBe(windowed.manual.pass_rate);

    // Sanity that the assertion isn't trivially passing on an empty
    // window — the seeded worker tenant always has runs.
    expect(windowed.automated.total_runs, "seed should have automated runs").toBeGreaterThan(0);
  });

  test("the Total-runs sub-count splits exactly into auto + manual", async ({ page }) => {
    await page.goto(WIDE_URL);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    const s = await fetchStats(page, WIDE_Q);

    const sub = (await page
      .locator(".summary .stat")
      .filter({ hasText: "Total runs" })
      .first()
      .locator(".stat-sub")
      .textContent())?.trim() ?? "";
    // Rendered as "<auto> auto · <manual> manual".
    expect(sub).toContain(`${s.automated.total_runs} auto`);
    expect(sub).toContain(`${s.manual.total_runs} manual`);
  });
});

test.describe("/dashboard — date filter changes the rendered data", () => {

  test("narrowing to a future window collapses every KPI to zero", async ({ page }) => {
    // First load the populated wide window so we have a non-zero
    // baseline to contrast against.
    await page.goto(WIDE_URL);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
    const baselineRuns = await kpiValue(page, "Total runs");
    expect(baselineRuns, "populated tenant should have runs in the wide window").toBeGreaterThan(0);

    // A window entirely in the future can match no run. Deep-link it so
    // readUrl() feeds it into loadStats() on mount — proves the stats
    // pipeline honours the range, not just the URL.
    await page.goto("/dashboard?from=2099-01-01&to=2099-12-31");
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    // Confirm the backend agrees this window is empty (guards against a
    // future seed accidentally landing data in 2099).
    const empty = await fetchStats(page, "?from=2099-01-01&to=2099-12-31");
    expect(empty.automated.total_runs).toBe(0);
    expect(empty.manual.total_runs).toBe(0);

    expect(await kpiValue(page, "Total runs")).toBe(0);
    expect(await kpiValue(page, "Failures")).toBe(0);

    // With no runs in range there are no suite comparisons → the Suite
    // Health section and at-risk band must be absent.
    await expect(page.getByRole("heading", { name: "Suite Health" })).toHaveCount(0);
    await expect(page.locator(".risk-band")).toHaveCount(0);

    // The recent-runs panel falls to its explicit empty copy.
    const autoPanel = page.locator(".panel").filter({ hasText: "Recent automated runs" });
    await expect(autoPanel.locator(".empty")).toHaveText("No runs yet.");
  });

  test("a narrow window shows fewer runs than the full range (the filter actually filters)", async ({ page }) => {
    // Render the full (wide) window and capture the headline count.
    await page.goto(WIDE_URL);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
    const wideStats = await fetchStats(page, WIDE_Q);
    const wideRuns = await kpiValue(page, "Total runs");
    expect(wideRuns).toBe(wideStats.automated.total_runs + wideStats.manual.total_runs);
    expect(wideRuns, "seed should populate the wide window").toBeGreaterThan(0);

    // Now a single recent day — strictly a subset, so the rendered count
    // must be ≤ the wide window, and the backend's own count must match
    // the tile. A subset that's also strictly smaller proves the date
    // bound is honoured (the seed spreads runs across ~60 days).
    const today = new Date().toISOString().slice(0, 10);
    await page.goto(`/dashboard?from=${today}&to=${today}`);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
    const dayStats = await fetchStats(page, `?from=${today}&to=${today}`);
    const dayRuns = await kpiValue(page, "Total runs");

    expect(dayRuns).toBe(dayStats.automated.total_runs + dayStats.manual.total_runs);
    expect(dayRuns, "a single day is a subset of the full range").toBeLessThan(wideRuns);
  });

  test("a deep-linked ?from&to re-hydrates the picker label and survives reload", async ({ page }) => {
    // The picker specs prove a click WRITES the URL; this proves the
    // inverse — landing on a pre-filtered URL READS it back into the
    // picker (readUrl on mount) so a shared link reproduces the view.
    const from = "2026-05-01";
    const to = "2026-05-31";
    await page.goto(`/dashboard?from=${from}&to=${to}`);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    // The trigger label reflects the loaded range (a multi-day span
    // renders "From – To", so it carries an en-dash) — not the default
    // "Last 7 days" / "All Time".
    await expect(page.locator(".trigger-label")).toContainText("–");

    // The KPI tile matches a fresh /stats over the same explicit window.
    const s = await fetchStats(page, `?from=${from}&to=${to}`);
    expect(await kpiValue(page, "Total runs")).toBe(s.automated.total_runs + s.manual.total_runs);

    // Reload — URL is the source of truth, so the params persist and the
    // view doesn't snap back to the default window.
    await page.reload();
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("from")).toBe(from);
    expect(url.searchParams.get("to")).toBe(to);
    await expect(page.locator(".trigger-label")).toContainText("–");
  });
});

test.describe("/dashboard — widget navigation", () => {

  test("a Suite Health card links into its compare/run detail route", async ({ page }) => {
    await page.goto("/dashboard?from=&to=");
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    const card = page.locator(".suite-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The card's href is either /compare?a=..&b=.. (has a previous run)
    // or /runs/<id> (first run). The footer disambiguates: "vs #N" means
    // a comparison, "first run" means a direct run link.
    const href = await card.getAttribute("href");
    expect(href, "suite card must be a real link, not a dead widget").toBeTruthy();
    const footer = (await card.locator(".sc-run-label").textContent())?.trim() ?? "";

    if (footer.includes("vs")) {
      expect(href).toMatch(/^\/compare\?a=\d+&b=\d+$/);
    } else {
      expect(href).toMatch(/^\/runs\/\d+$/);
    }

    // Following it lands on the matching destination, fully loaded.
    await card.click();
    if (href!.startsWith("/compare")) {
      await expect(page).toHaveURL(/\/compare\?a=\d+&b=\d+/);
      await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(page).toHaveURL(/\/runs\/\d+/);
      // Run detail has no data-ready — its loaded signal is the header.
      await expect(page.locator(".run-header")).toBeVisible({ timeout: 10_000 });
    }
  });

  test("a recent-failure entry deep-links to the run that produced it", async ({ page }) => {
    await page.goto("/dashboard?from=&to=");
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    const failurePanel = page.locator(".panel").filter({ hasText: "Recent failures" });
    await expect(failurePanel).toBeVisible({ timeout: 10_000 });

    // The seeded worker tenant has failures, so the panel is populated
    // rather than showing "No failures. Nice!".
    const firstFailure = failurePanel.locator(".failure-list a").first();
    await expect(firstFailure).toBeVisible({ timeout: 10_000 });

    const href = await firstFailure.getAttribute("href");
    // Automated failures point at /runs/<id>; manual ones at /manual-tests.
    expect(href).toMatch(/^(\/runs\/\d+|\/manual-tests)$/);

    await firstFailure.click();
    if (href!.startsWith("/runs/")) {
      const runId = href!.split("/")[2];
      await expect(page).toHaveURL(new RegExp(`/runs/${runId}(\\?.*)?$`));
      // The run-detail route has no data-ready attribute — its loaded
      // signal is the polished header card rendering (mirrors the
      // runs-critical + cross-tenant specs).
      await expect(page.locator(".run-header")).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(page).toHaveURL(/\/manual-tests/);
    }
  });
});

test.describe("/dashboard — empty tenant scoping", () => {
  // DEMO_USER owns the empty Demo Team org. The dashboard for an org with
  // zero runs must report zeros and show the explicit empty panels — and
  // must NEVER surface another tenant's numbers (RLS / org-scoping fence).
  test.use({ storageState: DEMO_USER.storageStatePath });

  test("an org with no data renders zeroed KPIs + every empty panel", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    // Confirm the org really is empty at the source (and that we're
    // scoped to it) before asserting the UI mirrors it.
    await token(page);
    const s = await fetchStats(page, "?from=&to=");
    expect(s.automated.total_runs, "Demo Team must have no automated runs").toBe(0);
    expect(s.manual.total_runs, "Demo Team must have no manual runs").toBe(0);

    // We're genuinely in Demo Team, not Acme — proves the zeros aren't a
    // "logged into the wrong tenant" false negative.
    await expect(page.locator("aside.sidebar .org-name")).toHaveText("Demo Team");

    // Every headline KPI is zero.
    expect(await kpiValue(page, "Total runs")).toBe(0);
    expect(await kpiValue(page, "Failures")).toBe(0);

    // No suite comparisons → no Suite Health section, no at-risk band.
    await expect(page.getByRole("heading", { name: "Suite Health" })).toHaveCount(0);
    await expect(page.locator(".risk-band")).toHaveCount(0);

    // All three activity panels show their explicit empty copy — never a
    // populated list leaked from another org.
    await expect(
      page.locator(".panel").filter({ hasText: "Recent automated runs" }).locator(".empty"),
    ).toHaveText("No runs yet.");
    await expect(
      page.locator(".panel").filter({ hasText: "Recent manual results" }).locator(".empty"),
    ).toHaveText("No manual test activity in this range.");
    await expect(
      page.locator(".panel").filter({ hasText: "Recent failures" }).locator(".empty"),
    ).toHaveText("No failures. Nice!");

    // And no run/failure rows leaked into any panel.
    await expect(page.locator(".run-list li")).toHaveCount(0);
    await expect(page.locator(".failure-list li")).toHaveCount(0);
  });
});
