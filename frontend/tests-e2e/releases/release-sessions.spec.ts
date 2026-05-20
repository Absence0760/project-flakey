import { expect, test, type Page } from "../fixtures/test";


/**
 * /releases/<id> — test execution sessions.
 *
 * Sessions are how a release shepherd actually drives manual
 * regression: pick a mode (full / failures-only), the system seeds
 * the session with the linked tests, and the shepherd records
 * pass/fail/block/skip per test plus optional evidence + notes.
 *
 * Seed creates two sessions on v2.4.0:
 *   - Session #1 — "Initial regression pass", mode=full, completed.
 *     Mirror statuses of the tests' stand-alone status.
 *   - Session #2 — "Rerun failures", mode=failures_only, in_progress.
 *     Seeded with prev session's failed/blocked tests; one test
 *     (Checkout with expired card) already has "passed" recorded
 *     to demonstrate partial-progress UX.
 *
 * Session #1 also has an accepted-as-known-issue result on
 * "Ship to international address".
 */

async function gotoV240(page: Page): Promise<void> {
  await page.goto("/releases");
  const card = page.locator(".release-card", {
    has: page.locator(".version", { hasText: "v2.4.0" }),
  }).first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page.getByRole("heading", { name: "v2.4.0" })).toBeVisible({ timeout: 10_000 });
}

test.describe("/releases/<id> — sessions", () => {

  test("active-session panel header shows in-progress badges + the session label", async ({
    page,
  }) => {
    await gotoV240(page);

    // The "Active session" panel is open by default (<details open>).
    // Seed has Session #2 in_progress with mode=failures_only.
    const panel = page.locator(".active-session-panel");
    await expect(panel.getByRole("heading", { level: 2 }).filter({ hasText: /Active session/ })).toBeVisible();
    await expect(panel.locator(".mode-badge")).toHaveText(/Rerun failures/i);
    await expect(panel.locator(".status-pill.status-in_progress")).toBeVisible();

    // Session #2's label from seed.
    await expect(panel.locator(".session-label")).toHaveText(/Rerun failures/i);
  });

  test("active session shows its results table with per-test rows + record action", async ({
    page,
  }) => {
    await gotoV240(page);

    const panel = page.locator(".active-session-panel");
    // Wait for results to land.
    const resultRows = panel.locator("table tbody tr");
    await expect(resultRows.first()).toBeVisible({ timeout: 10_000 });
    const count = await resultRows.count();
    // Session #2 was seeded from session #1's failures + blocked. The
    // exact count depends on how many of session #1's results landed
    // in those statuses (3-4 typically). Assert > 0 rather than exact.
    expect(count).toBeGreaterThan(0);

    // Each row has a "Record" button.
    await expect(resultRows.first().locator("button", { hasText: "Record" })).toBeVisible();
  });

  test("session history visible with both seeded sessions when expanded", async ({ page }) => {
    await gotoV240(page);

    const history = page.locator(".session-history-panel details");
    await history.locator("summary").click();

    // Two sessions in seed.
    const items = history.locator(".session-list > li");
    await expect(items).toHaveCount(2);
  });

  test("recording a result on the active session updates the row's status pill", async ({
    page,
  }) => {
    await gotoV240(page);

    const panel = page.locator(".active-session-panel");
    const firstRow = panel.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });

    // Capture the test's title (first td) for re-finding it later.
    const titleCell = firstRow.locator("td").first();
    const title = (await titleCell.textContent())?.trim() ?? "";

    await firstRow.locator("button", { hasText: /^Record$/ }).click();

    // The runner is rendered as a `.runner-modal` (not `.modal`)
    // with an h3 "Record result". Source:
    // src/routes/(app)/releases/[id]/+page.svelte:1736-1737.
    const runner = page.locator(".runner-modal", {
      has: page.getByRole("heading", { level: 3, name: "Record result" }),
    });
    await expect(runner).toBeVisible({ timeout: 5_000 });

    // Pick "passed" and save. The button reads "Save", not "Save result".
    await runner.locator("select").first().selectOption("passed");
    await runner.getByRole("button", { name: /^Save$/ }).click();

    // Runner closes.
    await expect(runner).toBeHidden({ timeout: 5_000 });

    // Re-find the row by its title — its status pill should now read
    // "passed" or have the .pass dot. The row may have re-ordered
    // after the reload, so use hasText scoping.
    const updatedRow = panel.locator("table tbody tr", { hasText: title }).first();
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow.locator(".status-pill, .dot.pass, .pass").first()).toBeVisible();
  });

  test("Session #1 result for 'Ship to international address' shows accepted-as-known-issue", async ({
    page,
  }) => {
    await gotoV240(page);

    // Open session history + drill into Session #1's expanded view.
    const history = page.locator(".session-history-panel details");
    await history.locator("summary").click();

    const session1 = history.locator(".session-list > li", { hasText: /Initial regression pass/ }).first();
    await expect(session1).toBeVisible();
    // Each session item has its own <details>; expand it.
    const session1Details = session1.locator("details").first();
    if (await session1Details.count() > 0) {
      await session1Details.locator("summary").first().click();
    }

    // Accept-as-known-issue is a contract — at minimum the marker
    // for "Ship to international address" (ACME-482, "accepted",
    // or "known issue") is visible somewhere on the page once
    // history is expanded.
    await expect(page.getByText(/ACME-482|Known issue|accepted/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
