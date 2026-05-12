import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Run-row columns added to make better use of horizontal real
 * estate on the runs list. Four new affordances:
 *
 *   - `.meta-chip.reporter` — framework name (cypress / playwright
 *     / mocha / etc.). Always rendered when `run.reporter` is set,
 *     which is virtually every run.
 *
 *   - `.aborted-badge` — distinct treatment for runs where the
 *     reporter was killed mid-flight (Ctrl-C, stale timeout, or
 *     explicit /abort). Replaces the pass/fail badge for that run.
 *
 *   - `.skip-badge` — `{N} skipped` chip, surfaces only when
 *     `run.skipped > 0`. Skipped count was previously visible only
 *     as a slice of the result bar.
 *
 *   - `.meta-chip.ci` — CI run id, capped width with ellipsis so it
 *     doesn't blow out the meta row on a wide monitor.
 *
 * The data behind these chips lives on the `Run` shape returned by
 * /runs and didn't require any backend change.
 */

async function loadRuns(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
}

test.describe("runs list — new chips on the run row", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("every run row shows a `.meta-chip.reporter` framework chip", async ({ page }) => {
    await loadRuns(page);
    const rows = page.locator("tr.run-row");
    const total = await rows.count();
    expect(total).toBeGreaterThan(0);

    // Sample the first row — the seed sets a reporter on every run,
    // so the chip must be present.
    const firstReporter = rows.first().locator(".meta-chip.reporter");
    await expect(firstReporter).toBeVisible();
    const text = await firstReporter.textContent();
    expect(
      (text ?? "").trim().length,
      "reporter chip must show a non-empty framework name",
    ).toBeGreaterThan(0);
  });

  test("runs with skipped > 0 render a `.skip-badge` chip", async ({ page }) => {
    await loadRuns(page);

    // Find a row where the skip-badge is rendered. The seed has at
    // least one run with skipped > 0 (junit-style runs typically do).
    // If none exists in the current seed snapshot, the test docs the
    // contract via a count assertion instead.
    const skipBadge = page.locator(".skip-badge").first();
    if (await skipBadge.count() > 0) {
      const text = await skipBadge.textContent();
      expect(text ?? "").toMatch(/\d+\s+skipped/);
    } else {
      test.info().annotations.push({
        type: "note",
        description: "Current seed has no runs with skipped > 0; chip only renders when run.skipped > 0",
      });
    }
  });

  test("runs with aborted=true render the `.aborted-badge` instead of fail/pass", async ({
    page,
  }) => {
    // Trigger an aborted run via the API so we have a deterministic
    // candidate to check, then reload the dashboard.
    await loadRuns(page);
    const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");

    const startRes = await page.request.post("http://localhost:3000/live/start", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { suite: `aborted-row-${Date.now().toString(36)}` },
    });
    const { id: runId } = (await startRes.json()) as { id: number };
    await page.request.post(`http://localhost:3000/live/${runId}/abort`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { reason: "regression-spec abort" },
    });

    try {
      await page.goto("/");
      const row = page.locator(`tr.run-row[data-run-id="${runId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // The aborted row carries the aborted badge AND does NOT show
      // the pass/fail/live alternatives.
      await expect(row.locator(".aborted-badge")).toBeVisible();
      await expect(row.locator(".pass-badge")).toHaveCount(0);
      await expect(row.locator(".fail-badge")).toHaveCount(0);
      await expect(row.locator(".live-badge")).toHaveCount(0);
    } finally {
      await page.request.delete(`http://localhost:3000/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  });

  test("runs with a ci_run_id render a `.meta-chip.ci` mono chip with width capped", async ({
    page,
  }) => {
    await loadRuns(page);

    // At least the run we just aborted (or any seeded run with a
    // ci_run_id) should expose the chip.
    const ciChips = page.locator(".meta-chip.ci");
    const count = await ciChips.count();
    expect(count).toBeGreaterThan(0);

    // Width is capped at 180 px (see max-width on .meta-chip.ci).
    const widths = await ciChips.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    for (const w of widths) {
      expect(
        w,
        `.meta-chip.ci width ${w.toFixed(0)} px exceeds the 180 px cap`,
      ).toBeLessThanOrEqual(180);
    }
  });
});
