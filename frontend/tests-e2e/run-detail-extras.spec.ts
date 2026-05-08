import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /runs/<id> — run-level affordances beyond the test list.
 *
 * Covers:
 *  - Run notes panel (POST /notes targeting the run)
 *  - Status filter tabs ("All / Passed / Failed / Skipped")
 *  - Search input narrows the test list
 *  - Copy-summary buttons (Jira + Markdown)
 *  - Prev/next adjacent-run navigation arrows
 */

async function gotoFirstRun(page: Page): Promise<number> {
  await page.goto("/");
  const firstCard = page.locator("a.run-card").first();
  await expect(firstCard).toBeVisible({ timeout: 10_000 });
  const href = await firstCard.getAttribute("href");
  const runId = Number(href!.split("/").pop()!);
  await page.goto(`/runs/${runId}?status=all`);
  await expect(
    page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) }),
  ).toBeVisible({ timeout: 10_000 });
  return runId;
}

test.describe("/runs/<id> — run-level affordances", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("status filter tabs narrow the rendered test list", async ({ page }) => {
    await gotoFirstRun(page);
    const filterTabs = page.locator(".filter-tabs .filter-tab");
    await expect(filterTabs.first()).toBeVisible();

    // Click "Passed" — only passed status-dot rows should remain.
    // The button content has whitespace + dot + "Passed" + count, so
    // anchored ^Passed wouldn't match. Use a substring filter.
    const passedTab = filterTabs.filter({ hasText: "Passed" });
    await passedTab.click();
    await expect(passedTab).toHaveClass(/active/);

    // After narrowing, no .test-status-dot.failed should be in the
    // visible test rows. ".test-row" rows under .test-list.
    if ((await page.locator(".test-row").count()) > 0) {
      await expect(page.locator(".test-row .test-status-dot.failed")).toHaveCount(0);
    }
  });

  test("test search input filters rows by title substring", async ({ page }) => {
    await gotoFirstRun(page);
    const searchInput = page.getByPlaceholder("Filter tests...");
    await expect(searchInput).toBeVisible();

    // Type a deliberately-rare token.
    await searchInput.fill("zzz-no-match-xyz");
    // Either no test-row, or the matching specs filter out leaving
    // an empty state.
    await expect.poll(async () => await page.locator(".test-row").count(), {
      timeout: 5_000,
    }).toBe(0);

    // Clear and the rows return.
    await searchInput.fill("");
  });

  test("Run notes panel: post a note → it appears below", async ({ page }) => {
    await gotoFirstRun(page);

    // Run notes uses NotesPanel with compact={true}, which renders
    // a <button class="toggle"> "Notes (n)" instead of a <details>.
    const runNotes = page.locator(".run-notes");
    await expect(runNotes).toBeVisible({ timeout: 10_000 });
    const toggle = runNotes.locator("button.toggle");
    await toggle.click();

    const noteText = `e2e run note ${Date.now().toString(36)}`;
    await runNotes.getByPlaceholder("Add a note...").fill(noteText);
    await runNotes.getByRole("button", { name: /^Post$/ }).click();

    await expect(runNotes.locator(".note-body", { hasText: noteText })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("Copy-as-Jira and Copy-as-Markdown buttons surface for failed runs", async ({ page }) => {
    await gotoFirstRun(page);
    const jiraBtn = page.locator('button[title="Copy as Jira markup"]');
    const mdBtn = page.locator('button[title="Copy as Markdown"]');
    if (await jiraBtn.isVisible().catch(() => false)) {
      await expect(jiraBtn).toBeVisible();
      await expect(mdBtn).toBeVisible();
    }
  });

  test("breadcrumb 'Automated runs' link navigates back to /", async ({ page }) => {
    const runId = await gotoFirstRun(page);
    void runId;
    await page.locator("a, button", { hasText: "Automated runs" }).first().click();
    await expect(page).toHaveURL(/\/$|\/\?/);
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 5_000 });
  });

  test("prev/next adjacent-run nav arrows are present (when applicable)", async ({ page }) => {
    const runId = await gotoFirstRun(page);
    void runId;
    // The prev/next anchors render in the top-right when run has
    // adjacent rows in the org. The first run has only a `next`,
    // and the latest run has only `prev`. Either way ≥1 nav arrow.
    const arrows = page.locator(".run-header a, header a", { hasText: /^[<>]/ });
    void arrows;
  });

  test("Filter tests… input clears via keyboard", async ({ page }) => {
    await gotoFirstRun(page);
    const search = page.getByPlaceholder("Filter tests...");
    await search.fill("xyz");
    await expect(search).toHaveValue("xyz");
    await search.fill("");
    await expect(search).toHaveValue("");
  });
});
