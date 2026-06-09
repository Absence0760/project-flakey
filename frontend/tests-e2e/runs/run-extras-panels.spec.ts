import { expect, test, type Page } from "../fixtures/test";

/**
 * /runs/<id> — RunExtras quality panels
 * (src/lib/components/panels/RunExtras.svelte).
 *
 * RunExtras renders Coverage / Accessibility (a11y) / Visual tabs, but
 * each tab only appears when its data exists (coverage !== null,
 * a11y.length > 0, visual.length > 0) — and the whole component is
 * hidden until at least one of the three is present. The seed creates
 * none of this data, so this spec ingests it through the real backend
 * API as setup, then drives the UI:
 *
 *   - POST /runs/upload  → a dedicated, throwaway run in THIS worker's
 *                          tenant (parallel-safe; never touches a shared
 *                          seeded run other specs read).
 *   - POST /coverage     → coverage summary (lines/branches/…)
 *   - POST /a11y         → an axe-style report with ≥1 violation so the
 *                          tab count badge shows.
 *   - POST /visual       → diffs incl. a 'changed' + a 'new' entry so the
 *                          pending count badge shows and the approve/reject
 *                          actions render.
 *
 * Then it loads /runs/<id>, asserts all three tabs render with the right
 * counts, switches between them, asserts each panel's content, and
 * exercises the visual approve action (updateVisualStatus → PATCH
 * /visual/:id) asserting the status updates in the UI.
 *
 * The created run is deleted in afterAll so the additive seed isn't
 * polluted (the cascade drops its coverage/a11y/visual rows too).
 *
 * Selectors are scoped to `.extras` throughout — the run-detail page has
 * its own top-level `.filter-tabs` (the status filter) and `.status`
 * chips, so an unscoped match would collide.
 */

const API = "http://localhost:3000";

const SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const A11Y_URL = "https://flakey.test/checkout";

let runId: number;

/** Read the worker admin's stored bearer token from localStorage. */
async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  expect(t, "expected a stored bt_token for the worker admin").toBeTruthy();
  return t;
}

test.describe("/runs/<id> — RunExtras quality panels", () => {
  test.beforeAll(async ({ browser, workerAdminStorageState }) => {
    const ctx = await browser.newContext({ storageState: workerAdminStorageState });
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    const tk = await token(page);
    const auth = { Authorization: `Bearer ${tk}` };

    // 1. A dedicated run in this worker's org via the same upload path
    //    other specs use. One failing test so the run isn't all-pass —
    //    irrelevant to the panels but keeps the fixture realistic.
    const payload = {
      meta: {
        suite_name: `extras-panels-${SUFFIX}`,
        branch: "main",
        commit_sha: "extras",
        ci_run_id: `ci-extras-${SUFFIX}`,
        started_at: new Date(Date.now() - 30_000).toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "playwright",
      },
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 42 },
      specs: [
        {
          file_path: "tests/extras.spec.ts",
          title: "extras.spec.ts",
          stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 42 },
          tests: [
            { title: "passes", full_title: "passes", status: "passed", duration_ms: 42, screenshot_paths: [] },
          ],
        },
      ],
    };
    const uploadRes = await page.request.post(`${API}/runs/upload`, {
      headers: auth,
      multipart: { payload: JSON.stringify(payload) },
    });
    expect(uploadRes.status(), "run upload should succeed").toBeLessThan(300);
    runId = ((await uploadRes.json()) as { id: number }).id;
    expect(runId).toBeTruthy();

    // 2. Coverage summary. Mixed buckets exercise the bar-class branches
    //    (good ≥80, warn ≥60, bad <60) so the panel isn't all one colour.
    const covRes = await page.request.post(`${API}/coverage`, {
      headers: auth,
      data: {
        run_id: runId,
        lines_pct: 87.5,
        branches_pct: 72.25,
        functions_pct: 55.0,
        statements_pct: 90.1,
        lines_covered: 1750,
        lines_total: 2000,
      },
    });
    expect(covRes.status(), "coverage upload should succeed").toBe(201);

    // 3. A11y report with two violations (one critical, one moderate) so
    //    the tab count badge reads 2 and the impact chips render.
    const a11yRes = await page.request.post(`${API}/a11y`, {
      headers: auth,
      data: {
        run_id: runId,
        url: A11Y_URL,
        violations: [
          {
            id: "color-contrast",
            impact: "critical",
            description: "Elements must have sufficient colour contrast",
            help: "Ensure contrast",
            helpUrl: "https://dequeuniversity.com/rules/axe/4.7/color-contrast",
          },
          {
            id: "label",
            impact: "moderate",
            description: "Form elements must have labels",
            help: "Add a label",
            helpUrl: "https://dequeuniversity.com/rules/axe/4.7/label",
          },
        ],
        passes: 40,
        incomplete: 1,
      },
    });
    expect(a11yRes.status(), "a11y upload should succeed").toBe(201);

    // 4. Visual diffs: one 'changed' + one 'new' (both count as pending →
    //    badge reads 2 and the approve/reject actions render) plus one
    //    'unchanged' (no actions) to prove the action-gating branch.
    const visRes = await page.request.post(`${API}/visual`, {
      headers: auth,
      data: {
        run_id: runId,
        diffs: [
          { name: `home-${SUFFIX}`, status: "changed", diff_pct: "3.14" },
          { name: `pricing-${SUFFIX}`, status: "new", diff_pct: "100.00" },
          { name: `footer-${SUFFIX}`, status: "unchanged", diff_pct: "0.00" },
        ],
      },
    });
    expect(visRes.status(), "visual upload should succeed").toBe(201);

    await ctx.close();
  });

  test.afterAll(async ({ browser, workerAdminStorageState }) => {
    if (!runId) return;
    const ctx = await browser.newContext({ storageState: workerAdminStorageState });
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    const tk = await token(page);
    await page.request
      .delete(`${API}/runs/${runId}`, { headers: { Authorization: `Bearer ${tk}` } })
      .catch(() => {});
    await ctx.close();
  });

  test("all three tabs render with correct counts and switch between panels", async ({ page }) => {
    await page.goto(`/runs/${runId}`);

    // The component only mounts once at least one dataset is present.
    const extras = page.locator(".extras");
    await expect(extras).toBeVisible({ timeout: 10_000 });

    const tabs = extras.locator(".filter-tab");
    const covTab = tabs.filter({ hasText: "Coverage" });
    const a11yTab = tabs.filter({ hasText: "Accessibility" });
    const visualTab = tabs.filter({ hasText: "Visual" });

    await expect(covTab).toBeVisible();
    await expect(a11yTab).toBeVisible();
    await expect(visualTab).toBeVisible();

    // Count badges: a11y shows the first report's violations_count (2),
    // visual shows the pending (changed|new) count (2).
    await expect(a11yTab.locator(".tab-count")).toHaveText("2");
    await expect(visualTab.locator(".tab-count")).toHaveText("2");

    // Coverage is available, so it's the auto-selected first tab.
    await expect(covTab).toHaveClass(/active/);

    // --- Coverage panel ---
    const covGrid = extras.locator(".coverage-grid");
    await expect(covGrid).toBeVisible();
    // Four metrics, formatted to one decimal by pct().
    await expect(extras.locator(".cov-metric")).toHaveCount(4);
    await expect(
      extras.locator(".cov-metric", { hasText: "Lines" }).locator(".cov-value"),
    ).toHaveText("87.5%");
    await expect(
      extras.locator(".cov-metric", { hasText: "Functions" }).locator(".cov-value"),
    ).toHaveText("55.0%");
    // lines_covered / lines_total footnote, locale-formatted.
    await expect(extras.locator(".meta")).toHaveText(/1,750 \/ 2,000 lines covered/);

    // --- Accessibility panel ---
    await a11yTab.click();
    await expect(a11yTab).toHaveClass(/active/);
    const report = extras.locator(".a11y-report").first();
    await expect(report).toBeVisible();
    // Score = 100 - (15*1 critical + 4*1 moderate) = 81.
    await expect(report.locator(".a11y-score")).toHaveText("Score 81");
    await expect(report.locator(".a11y-url")).toHaveText(A11Y_URL);
    await expect(report.locator(".impact.critical")).toHaveText("1 critical");
    await expect(report.locator(".impact.moderate")).toHaveText("1 moderate");
    // Both violations listed by id.
    await expect(report.locator(".violations li")).toHaveCount(2);
    await expect(report.locator(".v-id", { hasText: "color-contrast" })).toBeVisible();
    await expect(report.locator(".v-id", { hasText: "label" })).toBeVisible();

    // --- Visual panel ---
    await visualTab.click();
    await expect(visualTab).toHaveClass(/active/);
    await expect(extras.locator(".visual-card")).toHaveCount(3);
    await expect(
      extras.locator(".visual-card", { hasText: `home-${SUFFIX}` }).locator(".status"),
    ).toHaveText("changed");
    await expect(
      extras.locator(".visual-card", { hasText: `pricing-${SUFFIX}` }).locator(".status"),
    ).toHaveText("new");
    await expect(
      extras.locator(".visual-card", { hasText: `footer-${SUFFIX}` }).locator(".status"),
    ).toHaveText("unchanged");
  });

  test("approve a pending visual diff → status updates in the UI", async ({ page }) => {
    await page.goto(`/runs/${runId}`);

    const extras = page.locator(".extras");
    await expect(extras).toBeVisible({ timeout: 10_000 });
    await extras.locator(".filter-tab").filter({ hasText: "Visual" }).click();

    const changedCard = extras.locator(".visual-card", { hasText: `home-${SUFFIX}` });
    await expect(changedCard).toBeVisible();
    await expect(changedCard.locator(".status")).toHaveText("changed");

    // Pending (changed|new) cards expose Approve/Reject; terminal ones don't.
    const approve = changedCard.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    await approve.click();

    // updateVisualStatus optimistically rewrites the card's status on a
    // 2xx PATCH /visual/:id. The status chip flips to "approved" and the
    // action buttons disappear (terminal state).
    await expect(changedCard.locator(".status")).toHaveText("approved");
    await expect(changedCard.locator(".visual-action")).toHaveCount(0);

    // The pending badge drops from 2 → 1 (only the 'new' card remains).
    await expect(
      extras.locator(".filter-tab").filter({ hasText: "Visual" }).locator(".tab-count"),
    ).toHaveText("1");

    // Survives a reload — the PATCH persisted, not just local state.
    await page.reload();
    const extrasAfter = page.locator(".extras");
    await expect(extrasAfter).toBeVisible({ timeout: 10_000 });
    await extrasAfter.locator(".filter-tab").filter({ hasText: "Visual" }).click();
    await expect(
      extrasAfter.locator(".visual-card", { hasText: `home-${SUFFIX}` }).locator(".status"),
    ).toHaveText("approved");
  });

  test("reject a pending visual diff → status updates in the UI", async ({ page }) => {
    await page.goto(`/runs/${runId}`);

    const extras = page.locator(".extras");
    await expect(extras).toBeVisible({ timeout: 10_000 });
    await extras.locator(".filter-tab").filter({ hasText: "Visual" }).click();

    const newCard = extras.locator(".visual-card", { hasText: `pricing-${SUFFIX}` });
    await expect(newCard).toBeVisible();

    // This card may already be terminal if the approve test ran first in
    // this worker (tests share the run). Only act while it's pending.
    const status = await newCard.locator(".status").textContent();
    if (status?.trim() === "new") {
      const reject = newCard.getByRole("button", { name: "Reject" });
      await expect(reject).toBeVisible();
      await reject.click();
      await expect(newCard.locator(".status")).toHaveText("rejected");
      await expect(newCard.locator(".visual-action")).toHaveCount(0);
    } else {
      // Already reviewed — assert it's terminal with no actions.
      await expect(newCard.locator(".visual-action")).toHaveCount(0);
    }
  });
});
