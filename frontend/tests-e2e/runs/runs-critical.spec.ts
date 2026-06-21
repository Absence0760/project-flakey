import { expect, test, type Page } from "../fixtures/test";


/**
 * Critical, currently-untested behaviours on the runs surface — the
 * "my build is red, what happened" triage path. These complement the
 * existing runs specs (runs.spec.ts covers suite/date/search/row-nav;
 * run-detail*.spec.ts cover the test list, notes, copy buttons, extras
 * panels) by filling the trust-critical gaps they don't reach:
 *
 *   1. List status filter — when you ask for "failed", every row you
 *      see must actually be failed (or aborted). A regression that let
 *      a passing run leak through the failed view would quietly lie
 *      about the build's health. Existing specs never exercise the
 *      list's ?status= filter.
 *
 *   2. List URL-state round-trip on LOAD (not just write). The other
 *      runs specs prove that *changing* a filter writes the URL; none
 *      prove the inverse — that deep-linking to a pre-filtered URL (or
 *      reloading one) re-populates the filter UI from the URL. That's
 *      the half that makes a shared link actually work.
 *
 *   3. List empty state — a filter that matches nothing must render the
 *      explicit "No test runs found." empty state with the
 *      "Try changing the filters." hint, not a blank table.
 *
 *   4. Run-detail failed-test drill-down: clicking a failed test's
 *      error bar opens the ErrorModal AND mirrors ?test=<id> into the
 *      URL, and that deep link survives a reload (the modal re-opens on
 *      the same test). The ErrorModal's own behaviour is covered from
 *      /errors; the run-detail entry point + deep-link round-trip is
 *      not covered anywhere.
 *
 * All read-only against the per-worker seeded tenant except where noted;
 * no shared state is mutated.
 */

const API = "http://localhost:3000";

/** Worker admin bearer token from localStorage (set by globalSetup sign-in). */
async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  expect(t, "expected a stored bt_token for the worker admin").toBeTruthy();
  return t;
}

test.describe("/runs list — status filter, URL round-trip, empty state", () => {

  test("status=failed shows only failed/aborted rows (badge matches data)", async ({ page }) => {
    // Deep-link straight into the failed view. The list reads ?status
    // on mount (readFiltersFromUrl), so the filter UI must reflect it
    // and the rendered rows must all be failed or aborted — never a
    // passing run. A leak here would mean the dashboard reports a green
    // run as part of "what's broken".
    await page.goto("/runs?status=failed&date=all");
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 15_000 });

    const rows = page.locator("tr.run-row");
    const count = await rows.count();
    // The seed guarantees failing runs across the worker tenant, so the
    // failed view over "all time" is non-empty.
    expect(count, "seed should include failed runs for the failed filter").toBeGreaterThan(0);

    // Every visible row's state badge must be the fail or aborted badge,
    // and never the pass badge. The state column renders exactly one of
    // .fail-badge / .aborted-badge / .live-badge / .pass-badge.
    expect(
      await page.locator("tr.run-row .pass-badge").count(),
      "no passed-run badge may appear under the failed filter",
    ).toBe(0);

    // …and each row carries a genuinely-failed signal (fail or aborted —
    // both are legitimate non-pass states the failed filter includes).
    const failOrAborted = page.locator(
      "tr.run-row .fail-badge, tr.run-row .aborted-badge, tr.run-row .live-badge",
    );
    expect(await failOrAborted.count()).toBe(count);
  });

  test("a deep-linked filter URL re-populates the filter UI on load and survives reload", async ({
    page,
  }) => {
    // Discover a real suite that has runs in this worker's tenant via the
    // API so the assertion is deterministic rather than hard-coded.
    await page.goto("/dashboard");
    const tk = await token(page);
    const suite = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/runs?limit=200`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("bt_token")}` },
      });
      const body = (await res.json()) as { runs: Array<{ suite_name: string }> };
      return body.runs.find((r) => r.suite_name)?.suite_name ?? null;
    }, API);
    void tk;
    expect(suite, "seed should populate at least one suite").toBeTruthy();

    // Land directly on a pre-filtered URL — exactly what a shared/
    // bookmarked link is. The list must hydrate the controls FROM the
    // URL (readFiltersFromUrl on mount), not reset them to defaults.
    const target = `/runs?suite=${encodeURIComponent(suite!)}&date=all`;
    await page.goto(target);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 15_000 });

    // The suite <select> inside the filter popover reflects the URL value.
    await page.locator(".filter-trigger").click();
    const suiteSelect = page.locator(".filters select").first();
    await expect(suiteSelect).toBeVisible();
    await expect(suiteSelect).toHaveValue(suite!);
    // Close the popover so it doesn't intercept later interactions.
    await page.locator(".filter-backdrop").click();

    // Every rendered row belongs to that suite — the URL filter is
    // actually applied, not merely shown.
    const suiteLabels = await page.locator("tr.run-row .run-suite").allTextContents();
    expect(suiteLabels.length).toBeGreaterThan(0);
    for (const label of suiteLabels) {
      expect(label.trim()).toBe(suite!.trim());
    }

    // Reload — the filter must persist (URL is the source of truth), not
    // snap back to "All suites".
    await page.reload();
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`suite=${encodeURIComponent(suite!)}`);
    await page.locator(".filter-trigger").click();
    await expect(page.locator(".filters select").first()).toHaveValue(suite!);
  });

  test("a filter that matches nothing renders the empty state with a hint", async ({ page }) => {
    // A search token that can't match any seeded run drives the list to
    // its empty branch. The contract is an explicit empty state + a
    // filter-specific hint, not a silently-blank table.
    const noMatch = `zzz-no-such-run-${Date.now().toString(36)}`;
    await page.goto(`/runs?q=${noMatch}&date=all`);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 15_000 });

    const empty = page.locator(".empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No test runs found.");
    // When a filter is active, the hint nudges toward changing it (vs.
    // the cold "upload results" copy on a genuinely-empty tenant).
    await expect(empty.locator(".hint")).toContainText("Try changing the filters.");
    // And no rows are rendered.
    await expect(page.locator("tr.run-row")).toHaveCount(0);
  });
});

test.describe("/runs/<id> — failed-test drill-down + ?test deep link", () => {

  /**
   * Find a run in this worker's tenant that has at least one failed test
   * carrying an error_message — the precondition for the error bar +
   * ErrorModal drill-down. Returns { runId, testId }.
   */
  async function findFailingTest(page: Page): Promise<{ runId: number; testId: number }> {
    await page.goto("/dashboard");
    await token(page); // assert we're authenticated before probing the API
    const found = await page.evaluate(async (api) => {
      const auth = { Authorization: `Bearer ${localStorage.getItem("bt_token")}` };
      const listRes = await fetch(`${api}/runs?limit=200`, { headers: auth });
      const list = (await listRes.json()) as { runs: Array<{ id: number; failed: number }> };
      // Newest failing runs first — they're most representative of the
      // triage path and most likely to carry error_message rows.
      const failing = list.runs.filter((r) => r.failed > 0);
      for (const r of failing) {
        const detailRes = await fetch(`${api}/runs/${r.id}`, { headers: auth });
        if (!detailRes.ok) continue;
        const detail = (await detailRes.json()) as {
          specs: Array<{ tests: Array<{ id: number; status: string; error_message?: string | null }> }>;
        };
        for (const spec of detail.specs) {
          for (const t of spec.tests) {
            if (t.status === "failed" && t.error_message) {
              return { runId: r.id, testId: t.id };
            }
          }
        }
      }
      return null;
    }, API);
    expect(found, "seed should include a failed test with an error message").toBeTruthy();
    return found!;
  }

  test("clicking a failed test's error bar opens the ErrorModal and deep-links ?test=", async ({
    page,
  }) => {
    const { runId, testId } = await findFailingTest(page);

    // Land on the run. The route auto-applies ?status=failed and
    // auto-expands failed specs, so the failed test's error bar is
    // visible without any clicking.
    await page.goto(`/runs/${runId}`);
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: 10_000 });

    const errorBar = page.locator(".test-error-bar").first();
    await expect(errorBar).toBeVisible({ timeout: 10_000 });
    // The bar surfaces the failure message inline — it must be non-empty.
    const inlineErr = (await errorBar.locator(".error-text").textContent())?.trim() ?? "";
    expect(inlineErr.length, "error bar should show the failure message").toBeGreaterThan(0);

    // Click the bar → the ErrorModal opens AND the URL gains ?test=<id>
    // so the exact failure is deep-linkable into a PR comment.
    await errorBar.click();
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator(".badge.failed")).toHaveText("FAILED");
    await expect(page).toHaveURL(new RegExp(`[?&]test=\\d+`), { timeout: 5_000 });

    // The opened test is THE one we drilled into — the deep-link param
    // carries its id, not some default.
    const openedTestId = Number(new URL(page.url()).searchParams.get("test"));
    expect(openedTestId).toBe(testId);

    // Escape closes the modal and strips ?test from the URL (closeTest).
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(page).not.toHaveURL(/[?&]test=/, { timeout: 5_000 });
  });

  test("a ?test=<id> deep link opens the modal on the right test after a reload", async ({
    page,
  }) => {
    const { runId, testId } = await findFailingTest(page);

    // Navigate directly to the deep link — the load-time handler
    // (onMount) must open the modal on exactly that test, proving the
    // shared-link contract end to end (not just the in-session click).
    await page.goto(`/runs/${runId}?test=${testId}`);

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator(".badge.failed")).toHaveText("FAILED");

    // Reload the deep link — the modal must re-open on the same test,
    // not vanish (the param is the source of truth across reloads).
    await page.reload();
    const dialogAfter = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialogAfter).toBeVisible({ timeout: 10_000 });
    await expect(dialogAfter.locator(".badge.failed")).toHaveText("FAILED");
    expect(Number(new URL(page.url()).searchParams.get("test"))).toBe(testId);
  });
});
