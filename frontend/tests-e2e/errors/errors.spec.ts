import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /errors — recurring test failures grouped by fingerprint.
 *
 * The route loads via fetchErrors() with selectedSuite + selectedStatus
 * as filters. Each error has a status (open / acknowledged / resolved
 * / wont-fix), an occurrence_count, and notes. Click an error-card
 * header → expand to see the affected tests + similar failures + AI
 * summary if enabled.
 *
 * Whether the seed produces error groups depends on its random failure
 * distribution; the spec asserts on the always-present chrome (filter
 * UI + either error-card list OR empty state).
 */

test.describe("/errors", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/errors");
  });

  test("renders the description + suite filter + status filter tabs", async ({ page }) => {
    await expect(
      page.getByText("Recurring test failures tracked with status and notes."),
    ).toBeVisible({ timeout: 10_000 });

    // Suite filter, defaults to "All suites".
    const suiteSelect = page.locator(".filters select");
    await expect(suiteSelect).toBeVisible();
    await expect(suiteSelect).toHaveValue("all");

    // Status filter: "All" + 5 status tabs (open / investigating /
    // known / fixed / ignored, per src/routes/(app)/errors/+page.svelte).
    // "All" is active by default.
    const allTab = page.locator(".filter-tabs .filter-tab", { hasText: "All" }).first();
    await expect(allTab).toHaveClass(/active/);

    // The five concrete-status tabs all have a colour dot inside.
    const statusTabs = page.locator(".filter-tabs .filter-tab .dot");
    await expect(statusTabs).toHaveCount(5);
  });

  test("page settles to either the error list or the empty pane (no stuck Loading...)", async ({
    page,
  }) => {
    // The route renders three terminal states: error-list / empty /
    // loadError. None of these is the "Loading..." status-text. A
    // regression that drops the fetch-result handler would leave the
    // page stuck on "Loading...".
    await expect(page.locator(".error-list, .empty, .status-text.error")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".status-text", { hasText: "Loading..." })).toHaveCount(0);
  });
});
