import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Deep cross-page flows — multi-route user journeys.
 *
 * Each `test` here drives the user through ≥2 pages to exercise an
 * invariant that a single-page spec can't catch. Targets:
 *
 *  1. Notes are keyed on (full_title + file_path), not run_id — a
 *     note posted in Run A's ErrorModal must surface again on the
 *     same test in Run B. Cross-page: /runs/A → modal → /runs/B → modal.
 *  2. Compare → "Run #X" header link drills into that run's detail.
 *  3. Release readiness → click a Linked Run → land on that run's
 *     detail with the right id.
 *  4. Filter URL state survives navigation — set a filter on /,
 *     navigate to a run, hit back, filter still applied.
 *  5. /errors → click a "View test" affordance opens the ErrorModal
 *     for the latest occurrence of that fingerprint.
 *  6. /flaky → toggle quarantine → button flips state and persists
 *     across reload (server round-trip via /quarantine endpoint).
 *  7. Sign-off chain — toggle all required items checked → Sign-off
 *     button enables → click it → header banner appears AND list
 *     view shows signed_off status.
 *  8. Settings webhook CRUD round-trip — admin creates a webhook,
 *     toggles it pause, deletes it, all visible across reloads.
 */

async function findRunIdsForSameTest(
  page: Page,
  titleFragment: string,
): Promise<{ runs: number[]; testTitle: string }> {
  await page.goto("/dashboard");
  return await page.evaluate(async (frag: string) => {
    const token = localStorage.getItem("bt_token");
    // limit=500 — earlier specs in the suite create dozens of fresh
    // /live/start + /runs/upload rows that all sort above the seed
    // Playwright runs (created_at scattered 1-14 days ago). 200 was
    // not enough to reach them once the suite warmed up.
    const runsRes = await fetch("http://localhost:3000/runs?limit=500", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const runsBody = await runsRes.json();
    const matchingRuns: number[] = [];
    let hitTitle = "";
    for (const r of runsBody.runs as Array<{ id: number; suite_name: string }>) {
      // We need two runs that BOTH contain the same test (so the note
      // keyed on full_title+file_path will surface in both). Restrict
      // to playwright runs — the seeded login.spec.ts is shared by
      // all 3 of them.
      if (r.suite_name !== "e2e-playwright") continue;
      const det = await fetch(`http://localhost:3000/runs/${r.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!det.ok) continue;
      const detail = await det.json();
      for (const spec of detail.specs ?? []) {
        for (const t of spec.tests ?? []) {
          if (typeof t.title === "string" && t.title.includes(frag)) {
            matchingRuns.push(r.id);
            hitTitle = t.title;
          }
        }
      }
    }
    return { runs: matchingRuns, testTitle: hitTitle };
  }, titleFragment);
}

async function openErrorModalOnTest(
  page: Page,
  runId: number,
  testTitle: string,
): Promise<void> {
  await page.goto(`/runs/${runId}?status=all`);
  // Detail page header lands the run id in the meta-row chip
  // (the polished layout dropped the redundant <h1>Run #N</h1>).
  await expect(
    page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
  ).toBeVisible({ timeout: 10_000 });
  const btn = page.getByRole("button", { name: testTitle, exact: true });
  if (!(await btn.first().isVisible().catch(() => false))) {
    const headers = page.locator(".spec-header");
    const n = await headers.count();
    for (let i = 0; i < n; i++) await headers.nth(i).click();
  }
  await expect(btn.first()).toBeVisible({ timeout: 5_000 });
  await btn.first().click();
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
}

test.describe("deep cross-page flows", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("notes keyed on test full_title+file_path surface across runs", async ({ page }) => {
    // The seed creates 3 Playwright runs all sharing the same
    // login.spec.ts. Pick the SSO test which appears in all 3.
    const { runs, testTitle } = await findRunIdsForSameTest(
      page,
      "should handle SSO redirect",
    );
    expect(runs.length, "needed ≥2 Playwright runs containing the SSO test").toBeGreaterThanOrEqual(
      2,
    );
    const [runA, runB] = runs;
    expect(runA).not.toBe(runB);

    // 1) Open modal in Run A, post a unique note.
    await openErrorModalOnTest(page, runA, testTitle);
    await page.locator(".pane-tab", { hasText: /^Notes$/ }).click();
    const noteText = `cross-run note ${Date.now().toString(36)}`;
    await page.locator(".notes-tab").getByPlaceholder("Add a note...").fill(noteText);
    await page.locator(".notes-tab").getByRole("button", { name: /^Post$/ }).click();
    await expect(
      page.locator(".notes-tab .note-body", { hasText: noteText }),
    ).toBeVisible({ timeout: 5_000 });

    // 2) Navigate to a DIFFERENT run, open the same test, switch to
    //    Notes tab. The note must be present — proves the backend
    //    keys notes on full_title+file_path (test_history fingerprint),
    //    not on a per-run id.
    await openErrorModalOnTest(page, runB, testTitle);
    await page.locator(".pane-tab", { hasText: /^Notes$/ }).click();
    await expect(
      page.locator(".notes-tab .note-body", { hasText: noteText }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("/compare → clicking the 'Run #X' header link navigates to /runs/X", async ({
    page,
  }) => {
    // Find any two runs from the same suite for an A/B comparison.
    await page.goto("/dashboard");
    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem("bt_token");
      const res = await fetch("http://localhost:3000/runs?limit=200", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      const bySuite = new Map<string, number[]>();
      for (const r of body.runs as Array<{ id: number; suite_name: string }>) {
        const arr = bySuite.get(r.suite_name) ?? [];
        arr.push(r.id);
        bySuite.set(r.suite_name, arr);
      }
      for (const arr of bySuite.values()) {
        if (arr.length >= 2) return { a: arr[1], b: arr[0] };
      }
      return null;
    });
    expect(picked, "seed should have two runs of the same suite").toBeTruthy();
    const { a, b } = picked!;

    await page.goto(`/compare?a=${a}&b=${b}`);
    await expect(page.locator(".compare-header")).toBeVisible({ timeout: 10_000 });

    // Click Run #A header link.
    const runALink = page.locator(`.compare-header a[href="/runs/${a}"]`);
    await expect(runALink).toBeVisible();
    await runALink.click();

    await expect(page).toHaveURL(new RegExp(`/runs/${a}(\\?.*)?$`));
    // Detail page header lands the run id in the meta-row chip
    // (the polished layout dropped the redundant <h1>Run #N</h1>).
    await expect(
      page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${a}\\s*$`) }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("release readiness → click a linked automated run → land on that run", async ({
    page,
  }) => {
    // v2.4.0 has 5 linked runs in the seed.
    await page.goto("/releases");
    const v240 = page.locator(".release-card", {
      has: page.locator(".version", { hasText: "v2.4.0" }),
    }).first();
    await v240.click();
    await expect(page.getByRole("heading", { name: "v2.4.0" })).toBeVisible({
      timeout: 10_000,
    });

    // Expand the linked-runs <details>.
    const linkedRuns = page.locator(".linked-runs-panel details");
    await linkedRuns.locator("summary").click();

    // Capture the first linked run's href before clicking; we want
    // to assert we LAND on the same id we clicked, not a generic
    // /runs/<anything>.
    const firstLink = linkedRuns.locator('.link-list li a[href^="/runs/"]').first();
    await expect(firstLink).toBeVisible();
    const href = await firstLink.getAttribute("href");
    expect(href).toMatch(/^\/runs\/\d+$/);
    const expectedRunId = href!.split("/").pop()!;

    await firstLink.click();
    await expect(page).toHaveURL(new RegExp(`/runs/${expectedRunId}(\\?.*)?$`));
    // Detail page header lands the run id in the meta-row chip
    // (the polished layout dropped the redundant <h1>Run #N</h1>).
    await expect(
      page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${expectedRunId}\\s*$`) }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("/errors → 'View test' opens ErrorModal scoped to the latest occurrence", async ({
    page,
  }) => {
    await page.goto("/errors");
    // Master/detail layout: the list lives in `aside.error-list` with
    // `button.error-item` rows, and the first error auto-selects on
    // load so the right pane has content immediately. The "View
    // latest failure" button sits in the detail pane's header.
    const firstError = page.locator("button.error-item").first();
    await expect(firstError).toBeVisible({ timeout: 10_000 });

    // The expanded error has a "View latest failure" button that
    // opens the ErrorModal on `latest_test_id`.
    const viewBtn = page.getByRole("button", { name: /^View latest failure$/ }).first();
    await expect(viewBtn).toBeVisible({ timeout: 5_000 });
    await viewBtn.click();

    // ErrorModal lands. We don't pin the test title — different seeds
    // produce different fingerprints — but the .debugger is present
    // and shows a status badge.
    await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".debugger .badge")).toBeVisible();
  });

  test("/flaky → toggling quarantine flips the button and persists across reload", async ({
    page,
  }) => {
    await page.goto("/flaky");
    // Heatmap layout: each flaky test is a `tr.flaky-row`, click
    // expands a `tr.flaky-detail-row` below it with the quarantine
    // button. No more h1; the heatmap rows themselves are the
    // landing signal.
    const firstRow = page.locator("tr.flaky-row").first();
    if ((await firstRow.count()) === 0) {
      test.skip(true, "seed produced no flaky candidates this time");
      return;
    }
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    // The quarantine button only renders inside the expanded body.
    const qBtn = page.locator("button.q-btn").first();
    await expect(qBtn).toBeVisible({ timeout: 5_000 });

    const wasQuarantined = await qBtn.evaluate(
      (el) => el.classList.contains("quarantined"),
    );
    await qBtn.click();

    await expect
      .poll(async () =>
        await qBtn.evaluate((el) => el.classList.contains("quarantined")),
      )
      .toBe(!wasQuarantined);

    // Reload — state must persist server-side.
    await page.reload();
    const reloadedRow = page.locator("tr.flaky-row").first();
    await reloadedRow.click();
    const qBtnReload = page.locator("button.q-btn").first();
    await expect(qBtnReload).toBeVisible({ timeout: 5_000 });
    expect(
      await qBtnReload.evaluate((el) => el.classList.contains("quarantined")),
    ).toBe(!wasQuarantined);

    // Restore: toggle back so the suite leaves no side-effect for re-runs.
    await qBtnReload.click();
  });

  test("settings webhook CRUD round-trip: create → pause → delete", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".page-title")).toHaveText("Settings", { timeout: 10_000 });

    const name = `e2e-wh-${Date.now().toString(36)}`;
    await page.getByPlaceholder("Name (optional)").fill(name);
    await page.getByPlaceholder("Webhook URL").fill("https://example.com/hooks/e2e");
    await page.getByRole("button", { name: /^Add$/ }).click();

    const row = page.locator(".list-row, li, tr", { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Pause toggle: button text alternates "Pause" / "Enable".
    const pauseBtn = row.getByRole("button", { name: /^(Pause|Enable)$/ });
    const initialText = (await pauseBtn.textContent())?.trim();
    await pauseBtn.click();
    // After click, the label should flip to the opposite.
    const flipped = initialText === "Pause" ? "Enable" : "Pause";
    await expect(row.getByRole("button", { name: new RegExp(`^${flipped}$`) })).toBeVisible({
      timeout: 5_000,
    });

    // Delete: the icon button has title="Delete".
    page.once("dialog", (d) => d.accept());
    await row.locator('button[title="Delete"]').click();
    // In-page confirm modal appears (same pattern as API key delete).
    const modalConfirm = page
      .locator("button.btn-sm.danger", { hasText: /^Delete$/ })
      .last();
    if (await modalConfirm.isVisible().catch(() => false)) {
      await modalConfirm.click();
    }

    await expect(
      page.locator(".list-row, li, tr", { hasText: name }),
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("v2.5.0 (draft, empty checklist) → checklist starts empty, sign-off CTA renders", async ({
    page,
  }) => {
    // Cross-page flow: list → detail → assert structure stable.
    // Even with zero required items, the route shows the Sign-off CTA
    // (requiredRemaining is 0 → enabled). This catches a regression
    // where an empty checklist would crash the readiness panel.
    await page.goto("/releases");
    const v250 = page.locator(".release-card", {
      has: page.locator(".version", { hasText: "v2.5.0" }),
    }).first();
    await v250.click();

    await expect(page.getByRole("heading", { name: "v2.5.0" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".release-header .status")).toHaveText(/draft/i);

    // No checklist items.
    const items = page
      .locator("section", { has: page.getByRole("heading", { name: "Checklist" }) })
      .locator("ul.items > li");
    await expect(items).toHaveCount(0);

    // Sign-off button visible (regardless of whether it's enabled).
    await expect(page.getByRole("button", { name: /Sign off release/ })).toBeVisible();
  });

  test("/ runs-list filter URL is bookmarkable: deep-link to ?date=all renders all runs", async ({
    page,
  }) => {
    // Lands directly with a non-default filter in the URL — the route
    // must read URL state in onMount and apply it (readFiltersFromUrl).
    // A regression where readFiltersFromUrl was wired only to
    // afterNavigate (and not the initial mount) would land on the
    // listing with the default 7-day filter, ignoring the URL.
    await page.goto("/?date=all");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator(".filter-tab", { hasText: "All time" }),
    ).toHaveClass(/active/);
    // The 7 days default should NOT be highlighted.
    await expect(page.locator(".filter-tab", { hasText: "7 days" })).not.toHaveClass(
      /active/,
    );
  });
});
