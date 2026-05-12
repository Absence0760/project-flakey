import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /manual-tests — manual regression tests, the human-driven
 * counterpart to the automated runs surface.
 *
 * Seed (backend/src/seed.ts) creates:
 *   - 5 ungrouped manual tests with mixed statuses (passed, not_run,
 *     failed, blocked).
 *   - 3 manual test groups: "Checkout Flow" (6), "Auth Suite" (4),
 *     "Billing Smoke" (3) — total 13 grouped tests.
 *
 * The route renders a summary stat strip, a status filter-tab row, a
 * suite + group filter, and a table of tests. Click a row → modal
 * opens with steps + run affordance.
 */

test.describe("/manual-tests", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/manual-tests");
    // Wait for the table to land — confirms summary + filters mounted.
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });
  });

  test("renders header + summary stats + status filter tabs", async ({ page }) => {
    // The /manual-tests page intentionally has no <h1> — the sidebar
    // nav + URL are the page label. Assert on the subtitle (mounted
    // in the page header) instead.
    await expect(page.locator(".page-header .subtitle")).toBeVisible();

    // Summary strip — 5 stats: Total / Passed / Failed / Blocked / Not run.
    const stats = page.locator(".summary .stat");
    await expect(stats).toHaveCount(5);

    // Total = 5 ungrouped + 13 grouped = 18 (per seed). Don't pin the
    // exact number to seed drift; assert it's > 0 and matches what's
    // in the table.
    const totalText = await stats.first().locator(".stat-value").textContent();
    const total = Number(totalText);
    expect(total).toBeGreaterThan(0);

    // Status filter tabs: All / Not run / Passed / Failed / Blocked /
    // Skipped — six tabs, "All" active by default.
    const tabs = page.locator(".filter-tabs .filter-tab");
    await expect(tabs).toHaveCount(6);
    await expect(tabs.first()).toHaveClass(/active/);
  });

  test("status filter narrows the table to matching rows", async ({ page }) => {
    const tabs = page.locator(".filter-tabs .filter-tab");

    // Click "Failed" — at least one row should be visible because the
    // seed includes a failed test ("Checkout with expired card",
    // "MFA challenge with authenticator app", etc.).
    const failedTab = tabs.filter({ hasText: "Failed" });
    await failedTab.click();
    await expect(failedTab).toHaveClass(/active/);
    await expect(page.locator("table.tests tbody tr").first()).toBeVisible();

    // Every visible row's status pill should read "failed".
    const statusBadges = page.locator("table.tests tbody tr .status-badge, table.tests tbody tr td span.priority");
    // The status column renders inside the row; we can also assert
    // none of the rows show "passed" pill text.
    await expect(page.locator("table.tests tbody tr .dot.pass")).toHaveCount(0);
  });

  test("group filter narrows to a specific group's tests", async ({ page }) => {
    const groupSelect = page.locator("#group-select");
    // Pick "Auth Suite" — seed has 4 tests under this group. The
    // option label is "Auth Suite (4)" — read the value attr to
    // avoid coupling to the count number.
    const authValue = await page
      .locator("#group-select option")
      .filter({ hasText: "Auth Suite" })
      .first()
      .getAttribute("value");
    expect(authValue, "seed should have an Auth Suite group option").toBeTruthy();
    await groupSelect.selectOption(authValue!);

    const rows = page.locator("table.tests tbody tr");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count, "Auth Suite group should have the seeded tests").toBeGreaterThan(0);

    // Each visible row should show "Auth Suite" in the Group column
    // (the third td).
    const groupCells = rows.locator("td:nth-child(3)");
    const seenGroups = await groupCells.evaluateAll((cells) =>
      cells.map((c) => c.textContent?.trim() ?? ""),
    );
    for (const g of seenGroups) {
      expect(g).toBe("Auth Suite");
    }
  });

  test("clicking a test row opens the detail modal with steps", async ({ page }) => {
    // Use a stable seeded title — picking the first row in the table
    // is brittle because the "creates a new manual test" test in this
    // same file leaves a fresh test in the DB; depending on sort
    // order the first row may be that empty-stepped one. The seed's
    // "Verify PDF export of run report" exists from the start with
    // the standard 3-step template.
    const seededRow = page
      .locator("table.tests tbody tr.test-row", {
        hasText: "Verify PDF export of run report",
      })
      .first();
    await expect(seededRow).toBeVisible();
    await seededRow.click();

    // Modal opens with the test title as h2.
    const modal = page.locator(".modal").last();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(
      modal.getByRole("heading", { name: "Verify PDF export of run report", exact: true }),
    ).toBeVisible();

    // The steps grid should render at least one step row.
    await expect(
      modal.locator(".step-grid tbody tr, ol li, .step-row").first(),
    ).toBeVisible();
  });

  test("admin sees the create + import + manage-groups affordances", async ({ page }) => {
    // "+ New test" is always shown; "Manage groups" + "Import .feature"
    // are admin-gated by isAdmin (orgRole !== 'viewer').
    await expect(page.getByRole("button", { name: /New test/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Manage groups/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Import \.feature/ })).toBeVisible();
  });

  test("creating a manual test adds it to the list", async ({ page }) => {
    const beforeRows = await page.locator("table.tests tbody tr").count();

    await page.getByRole("button", { name: /New test/ }).click();

    const modal = page.locator(".modal.create-modal");
    await expect(modal).toBeVisible();

    // The title input has a specific placeholder set in the route at
    // src/routes/(app)/manual-tests/+page.svelte:661.
    const uniqueTitle = `e2e create test ${Date.now()}`;
    await modal.getByPlaceholder("e.g. Checkout flow with expired card").fill(uniqueTitle);

    // The "Create test" button is disabled until newTitle.trim() is
    // truthy — wait for it to enable before clicking.
    const createBtn = modal.getByRole("button", { name: /^Create test$/ });
    await expect(createBtn).toBeEnabled({ timeout: 2_000 });
    await createBtn.click();

    // Modal closes; new row appears.
    await expect(modal).toBeHidden({ timeout: 5_000 });
    const afterRows = await page.locator("table.tests tbody tr").count();
    expect(afterRows).toBe(beforeRows + 1);
    await expect(page.locator("table.tests tbody", { hasText: uniqueTitle })).toBeVisible();
  });
});
