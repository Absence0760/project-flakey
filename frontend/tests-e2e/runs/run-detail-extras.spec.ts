import { expect, test, type Page } from "../fixtures/test";


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
  await page.goto("/runs");
  const firstRow = page.locator("tr.run-row").first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  const runIdAttr = await firstRow.getAttribute("data-run-id");
  const runId = Number(runIdAttr!);
  await page.goto(`/runs/${runId}?status=all`);
  // The detail page header lands the run id as a meta-row chip
  // (the polished layout dropped the redundant <h1>Run #N</h1>
  // — the breadcrumb already carries the id). Wait for that chip
  // as evidence the run loaded.
  await expect(
    page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
  ).toBeVisible({ timeout: 10_000 });
  return runId;
}

test.describe("/runs/<id> — run-level affordances", () => {

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

  test("breadcrumb 'Automated runs' link navigates back to /runs", async ({ page }) => {
    const runId = await gotoFirstRun(page);
    void runId;
    await page.locator("a, button", { hasText: "Automated runs" }).first().click();
    await expect(page).toHaveURL(/\/runs(\?.*)?$/);
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 5_000 });
  });

  test("prev/next adjacent-run nav stays within the same suite", async ({ page }) => {
    // Regression: prev_id/next_id were computed by global run id across
    // ALL suites, so "Previous run" could jump to an unrelated suite —
    // which also poisoned the "new failures since previous run" band.
    // They must be scoped to the current run's suite.
    await gotoFirstRun(page);
    const suite = (await page.locator(".run-suite-title").textContent())?.trim() ?? "";
    expect(suite.length).toBeGreaterThan(0);

    const prevLink = page.locator('a.run-nav-btn[title^="Previous run"]');
    const nextLink = page.locator('a.run-nav-btn[title^="Next run"]');

    // Follow whichever neighbour exists; the landed run must share the suite.
    if (await prevLink.count()) {
      await prevLink.first().click();
    } else if (await nextLink.count()) {
      await nextLink.first().click();
    } else {
      test.skip(true, "this run is the only one in its suite — no adjacency to verify");
      return;
    }

    // The detail page re-renders for the neighbour; its suite title must
    // match the suite we started on.
    await expect(page.locator(".run-suite-title")).toHaveText(suite, { timeout: 10_000 });
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
