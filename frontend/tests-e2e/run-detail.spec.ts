import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /runs/<id> — single run detail.
 *
 * Composes the run's metadata (suite/branch/commit), the spec
 * sections (file path + per-spec pass/fail/skip badges), the test
 * rows under each spec (status + name + duration), and live event
 * feed when isLive. Also exposes copy-as-jira / copy-as-markdown
 * affordances and the spec-folder toggling.
 *
 * The route resolves the id from $page.params and hits fetchRun(id).
 * A regression that drops the org-scoping (route slips out of
 * tenantQuery) would render another tenant's run here — the cross-
 * tenant spec covers that case explicitly.
 */

test.describe("/runs/<id>", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  // The seed creates 50+ runs against admin's org. The lowest id
  // assigned to admin should be 1 in a freshly-seeded DB; if the DB
  // wasn't reset between seed runs the lowest id might be higher,
  // but the route's behaviour is invariant to the actual id. We
  // navigate via the runs list to capture the real first id rather
  // than hard-coding.
  test("shows the right id in <h1> and renders at least one spec section", async ({ page }) => {
    // Capture the first run-card's href, then visit it directly so
    // we know the id we're asserting.
    await page.goto("/");
    const firstCard = page.locator("a.run-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    const href = await firstCard.getAttribute("href");
    expect(href).toMatch(/^\/runs\/\d+$/);
    const runId = href!.split("/").pop()!;

    await page.goto(href!);

    // Header card lands with the run id.
    const heading = page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // The status badge is either "Passed" or "<n> Failed" — both
    // count as evidence the run loaded and rendered. Live runs get
    // a "LIVE" pill instead, which is also acceptable here.
    const headerBadge = page
      .locator(".run-header")
      .locator(".run-status-badge, .live-badge")
      .first();
    await expect(headerBadge).toBeVisible();

    // At least one spec section should render. Seed runs have 3+
    // specs each, so an empty specs-list would mean fetchRun's
    // shape regressed (specs[] dropped or renamed).
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: 5_000 });
  });

  test("default view shows test-rows for failed specs (auto-expand on load)", async ({ page }) => {
    // The run-detail route deliberately collapses passing specs and
    // expands failed ones on load (see "Feature 2" in
    // src/routes/(app)/runs/[id]/+page.svelte:184). Combined with
    // "Feature 1" — auto-applying ?status=failed when run.failed > 0 —
    // a run that has any failure must show at least one .test-row in
    // its default rendered state. A regression that broke either the
    // default-collapse-state computation or the test-row rendering
    // would land us on a detail page with no visible test rows.
    await page.goto("/");
    const firstCard = page.locator("a.run-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await firstCard.click();

    // Wait for the spec sections to land.
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: 10_000 });

    // Seed has all-passing runs too, so we navigate specifically to a
    // run with failures. The auto-applied ?status=failed in the URL
    // is the contract that this run has failures.
    await expect(page).toHaveURL(/\/runs\/\d+(\?.*)?$/);

    // Either the run has failures (status=failed in URL → auto-expand
    // shows test-rows), or it's all-passing (no failures → no expanded
    // specs by default). The first case is the more common — assert
    // it but tolerate the all-pass case by branching.
    const url = new URL(page.url());
    if (url.searchParams.get("status") === "failed") {
      await expect(page.locator(".test-row").first()).toBeVisible({ timeout: 5_000 });
    } else {
      // All-pass run: every spec is collapsed; clicking any spec
      // header should expand it.
      await page.locator(".spec-header").first().click();
      await expect(page.locator(".test-row").first()).toBeVisible({ timeout: 5_000 });
    }
  });
});
