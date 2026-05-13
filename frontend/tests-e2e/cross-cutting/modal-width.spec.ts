import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * ErrorModal .debugger panel was capped at max-width: 1200px, which
 * on a 2K monitor left ~1300 px of dead space inside the backdrop
 * — the same complaint the .page cap had at 1440 (the previous
 * commit widened that to 1920).
 *
 * Bumped to 1800 px so the snapshot/screenshot pane on the left and
 * the command-log/info pane on the right both have room to breathe
 * before the splitter eats any width.
 *
 * Regression: on a 2560×1440 viewport the rendered .debugger width
 * should be >= 1700 px. The old 1200 cap would render at exactly
 * 1200 px → far below the threshold → spec fails decisively.
 */

const WIDE_VIEWPORT = { width: 2560, height: 1440 };

async function openRunWithErrorBar(page: Page): Promise<void> {
  // Find a run whose tests actually have `error_message` populated
  // — the `.test-error-bar` only renders when `{#if test.error_message}`
  // is true. Cucumber-style runs report failure at the spec level
  // without per-test rows, so we can't rely on `.fail-badge` alone.
  //
  // The runs-list is rendered as `tr.run-row` (table layout); we use
  // it as a "page is hydrated" probe only.
  //
  // Query the backend directly via the localStorage bt_token (same
  // auth the frontend uses). Walk the runs list paged at 200, find
  // the first run with at least one failed test that has
  // error_message, navigate there.
  await page.goto("/runs");
  await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("no auth token in localStorage");

  const runsRes = await page.request.get("http://localhost:3000/runs?limit=200", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { runs } = (await runsRes.json()) as { runs: { id: number; failed: number }[] };
  const candidates = runs.filter((r) => r.failed > 0).map((r) => r.id);

  for (const id of candidates) {
    const detailRes = await page.request.get(`http://localhost:3000/runs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = (await detailRes.json()) as {
      specs?: { tests?: { error_message?: string | null }[] }[];
    };
    const hasErrorMessage = (detail.specs ?? []).some((s) =>
      (s.tests ?? []).some((t) => typeof t.error_message === "string" && t.error_message.length > 0),
    );
    if (hasErrorMessage) {
      await page.goto(`/runs/${id}`);
      await page.locator(".test-error-bar").first().waitFor({ timeout: 10_000 });
      return;
    }
  }
  throw new Error("No failing run with a test that has error_message found in the first 200 runs");
}

test.describe("ErrorModal panel width on a wide viewport", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath, viewport: WIDE_VIEWPORT });

  test(".debugger panel uses the wider cap on a 2560-wide viewport", async ({ page }) => {
    test.setTimeout(45_000);

    await openRunWithErrorBar(page);

    await page.locator(".test-error-bar").first().click();
    const debugger_ = page.locator(".debugger");
    await expect(debugger_).toBeVisible({ timeout: 5_000 });

    const width = await debugger_.evaluate((el) => el.getBoundingClientRect().width);

    // Old cap rendered at exactly 1200 px. New cap is 1800 px; allow
    // a small buffer for inner padding / border. 1700 is well above
    // the old cap and just below the new one — fails fast on a
    // regression in either direction.
    expect(
      width,
      `.debugger width (${width.toFixed(0)} px) is below the new 1800 px cap — old 1200 cap may be back`,
    ).toBeGreaterThanOrEqual(1700);

    // Sanity ceiling: must not exceed the viewport minus the layout
    // padding (1.5 rem each side from .backdrop = 24 px → keep room
    // for shadow + border).
    expect(width).toBeLessThanOrEqual(WIDE_VIEWPORT.width - 40);
  });
});
