import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /manual-tests — step-by-step runner.
 *
 * Each non-cucumber manual test exposes a "Run test" CTA inside the
 * detail modal. Clicking it puts the test into `runMode`, replacing
 * the readonly steps grid with a runner-grid where each step gets
 * pass/fail/blocked/skipped buttons + an optional comment textarea.
 * Marking each step builds up `stepRuns[]`; clicking "Save run"
 * POSTs to /manual-tests/:id/run with the steps and a derived overall
 * status, then re-renders the readonly grid showing "Last result"
 * for each step.
 *
 * Catches regressions in:
 *  - the runMode → runner-grid swap
 *  - per-step state updates (active class on the chosen result-btn)
 *  - the derived overall status in the runner footer
 *  - the save round-trip refreshing the test row
 */

test.describe("manual-test step-by-step runner", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin can run all steps as passed → save → row + steps reflect the run", async ({
    page,
  }) => {
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    // The seeded "Verify PDF export of run report" test is non-cucumber
    // (so the "Run test" CTA appears) and has the standard 3-step
    // template — same row used by manual-tests.spec.ts and the
    // manual-test-requirements spec, so we know it's stable across
    // re-seeds.
    await page
      .locator("table.tests tbody tr.test-row", {
        hasText: "Verify PDF export of run report",
      })
      .first()
      .click();

    const modal = page.locator(".modal").last();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Click "Run test" — runMode becomes true and the runner grid mounts.
    await modal.getByRole("button", { name: /Run test/ }).click();
    const runnerGrid = modal.locator("table.step-grid.runner");
    await expect(runnerGrid).toBeVisible({ timeout: 2_000 });

    // The runner grid has one row per step. Pick the "passed" button
    // on each row (the first result-btn in each row's result-buttons).
    const rows = runnerGrid.locator("tbody tr.runner-row");
    const stepCount = await rows.count();
    expect(stepCount, "seeded test should have ≥1 step").toBeGreaterThan(0);

    for (let i = 0; i < stepCount; i++) {
      const passBtn = rows.nth(i).locator(".result-btn.result-passed");
      await passBtn.click();
      // The chosen button picks up the .active class via class:active.
      await expect(passBtn).toHaveClass(/\bactive\b/, { timeout: 1_000 });
    }

    // The runner-footer's "Overall" line derives from stepRuns; with
    // every step passed it should read "passed".
    await expect(modal.locator(".runner-footer .derived")).toContainText(/passed/i);

    // Save the run. The route's saveRunnerResult sets `selected = null`
    // after the POST resolves, so the modal closes and the table re-loads.
    await modal.getByRole("button", { name: /^Save run$/ }).click();

    // Modal closes; the row in the main table reflects the new status.
    await expect(modal).toBeHidden({ timeout: 5_000 });
    const row = page
      .locator("table.tests tbody tr.test-row", { hasText: "Verify PDF export of run report" })
      .first();
    await expect(row.locator(".status-pill, .status, td", { hasText: /passed/i }).first())
      .toBeVisible({ timeout: 5_000 });
  });

  test("'Record result without running' inline form posts an overall status", async ({
    page,
  }) => {
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    await page
      .locator("table.tests tbody tr.test-row", {
        hasText: "Verify PDF export of run report",
      })
      .first()
      .click();

    const modal = page.locator(".modal").last();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Open the <details> "Record result without running" panel.
    const quickResult = modal.locator("details.quick-result");
    await expect(quickResult).toBeVisible();
    await quickResult.locator("summary").click();

    // Pick "blocked" (any non-default value) and post.
    await quickResult.locator("select").selectOption("blocked");
    await quickResult.getByRole("button", { name: /^Save result$/ }).click();

    // recordResult closes the modal and reloads the list. The row's
    // status cell should reflect the new "blocked" status.
    await expect(modal).toBeHidden({ timeout: 5_000 });
    const row = page
      .locator("table.tests tbody tr.test-row", { hasText: "Verify PDF export of run report" })
      .first();
    await expect(row.locator("td", { hasText: /blocked/i }).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
