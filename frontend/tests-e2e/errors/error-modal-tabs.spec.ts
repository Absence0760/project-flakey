import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * ErrorModal — non-Commands tabs.
 *
 * snapshot-viewer.spec.ts already covers Commands. This file covers
 * the other right-pane tabs:
 *   - Info     (always)
 *   - Source   (when test_code exists — mochawesome runs in seed)
 *   - Details  (when metadata exists — Playwright runs in seed)
 *   - History  (always; lazy-fetches /tests/{id}/history)
 *   - Notes    (always; CRUD via POST /notes)
 *
 * Each test routes into a specific seeded test where the relevant
 * data is present, rather than relying on whichever test happens
 * to be at the top of a run.
 */

/**
 * Locate a run id + test id for a test matching `titleFragment` AND the
 * data shape the caller needs (test_code, metadata, command_log).
 *
 * The naive "first title match" approach is brittle because the dev DB
 * accumulates synthetic runs from other specs (live-run, live-reporter-
 * adapters, etc.). When a synthetic run shares a title fragment with a
 * seeded test, the synthetic match wins and the test fails because the
 * synthetic record has no test_code / metadata / command_log.
 *
 * Filtering on the data shape returns the right run regardless of how
 * many synthetic runs exist or what they're titled.
 */
async function findRunAndTest(
  page: Page,
  match: {
    titleFragment: string;
    needsCode?: boolean;
    needsMetadata?: boolean;
    needsCommandLog?: boolean;
  },
): Promise<{ runId: number; testId: number }> {
  await page.goto("/dashboard");
  const result = await page.evaluate(async (criteria) => {
    const token = localStorage.getItem("bt_token");
    // limit=500 — earlier specs in the suite create dozens of fresh
    // /live/start + /runs/upload rows that all sort above the seed
    // Playwright runs (created_at scattered 1-14 days ago). 200 was
    // not enough to reach them once the suite warmed up.
    const runsRes = await fetch("http://localhost:3000/runs?limit=500", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const runsBody = await runsRes.json();
    for (const r of runsBody.runs as Array<{ id: number }>) {
      const det = await fetch(`http://localhost:3000/runs/${r.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!det.ok) continue;
      const detail = await det.json();
      for (const spec of detail.specs ?? []) {
        for (const t of spec.tests ?? []) {
          if (typeof t.title !== "string" || !t.title.includes(criteria.titleFragment)) continue;
          if (criteria.needsCode && !t.test_code) continue;
          if (criteria.needsMetadata && !t.metadata) continue;
          if (criteria.needsCommandLog && !t.command_log) continue;
          return { runId: r.id, testId: t.id };
        }
      }
    }
    return null;
  }, match);
  expect(
    result,
    `expected a run/test matching ${JSON.stringify(match)}`,
  ).toBeTruthy();
  return result!;
}

async function openModalForTest(
  page: Page,
  runId: number,
  testTitle: string,
): Promise<void> {
  // ?status=all overrides the route's Feature 1 (auto-filter to failed
  // when run.failed > 0). Without it, passing tests in passing specs
  // are filtered out of the rendered tree entirely. We still have to
  // manually expand passing spec sections (Feature 2 collapses them).
  await page.goto(`/runs/${runId}?status=all`);
  await expect(
    page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) }),
  ).toBeVisible({ timeout: 10_000 });

  const testButton = page.getByRole("button", { name: testTitle, exact: true });
  if (!(await testButton.first().isVisible().catch(() => false))) {
    // Expand every spec section so the test row mounts.
    const specHeaders = page.locator(".spec-header");
    const n = await specHeaders.count();
    for (let i = 0; i < n; i++) {
      await specHeaders.nth(i).click();
    }
  }
  await expect(testButton.first()).toBeVisible({ timeout: 5_000 });
  await testButton.first().click();
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
}

test.describe("ErrorModal — Info / History / Notes (always-present tabs)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Info tab shows test metadata strip + error message for failures", async ({ page }) => {
    // The gherkin demo failed test — guaranteed to exist post-seed
    // and has both a populated command_log AND error_message.
    const { runId } = await findRunAndTest(page, {
      titleFragment: "Gherkin demo",
      needsCommandLog: true,
    });
    await openModalForTest(page, runId, "Login with valid credentials (Gherkin demo)");

    // Info tab is the default for tests without snapshots, but the
    // gherkin test has a snapshot so leftTab defaults to "snapshot"
    // and rightTab still defaults to "info" (per ErrorModal:174).
    await page.locator(".pane-tab", { hasText: /^Info$/ }).click();
    await expect(page.locator(".info-panel")).toBeVisible({ timeout: 2_000 });

    // Detail rows: Test, Spec, Status, Duration, Run.
    const detailRows = page.locator(".info-panel .detail-row");
    await expect(detailRows).toHaveCount(5);
    await expect(detailRows.filter({ hasText: "Status" }).locator(".info-status")).toHaveText(
      "failed",
    );

    // Error section shows the error message verbatim from seed.
    await expect(page.locator(".info-panel .error-msg")).toContainText(
      "expected URL to include /dashboard",
    );
  });

  test("History tab lazy-loads and renders a timeline entry", async ({ page }) => {
    // The seeded SSO test has metadata populated (retries, annotations,
    // stdout) — pin the lookup to that data shape so synthetic e2e
    // runs (no metadata) can't shadow it.
    const { runId } = await findRunAndTest(page, {
      titleFragment: "should handle SSO redirect",
      needsMetadata: true,
    });
    await openModalForTest(page, runId, "should handle SSO redirect");

    // History is gated behind a click — selectHistoryTab() triggers
    // loadHistory() lazily.
    const historyTab = page.locator(".pane-tab", { hasText: /^History$/ });
    await historyTab.click();
    await expect(historyTab).toHaveClass(/active/);

    // Timeline lands. There's always ≥1 entry (the current test).
    const timeline = page.locator(".history-timeline");
    await expect(timeline).toBeVisible({ timeout: 5_000 });
    await expect(timeline.locator(".history-entry").first()).toBeVisible();
  });

  test("Notes tab posts a new note + shows it back", async ({ page }) => {
    const { runId } = await findRunAndTest(page, {
      titleFragment: "Gherkin demo",
      needsCommandLog: true,
    });
    await openModalForTest(page, runId, "Login with valid credentials (Gherkin demo)");

    await page.locator(".pane-tab", { hasText: /^Notes$/ }).click();
    const notesTab = page.locator(".notes-tab");
    await expect(notesTab).toBeVisible({ timeout: 2_000 });

    const noteText = `e2e note ${Date.now()}`;
    const input = notesTab.getByPlaceholder("Add a note...");
    await input.fill(noteText);
    await notesTab.getByRole("button", { name: /^Post$/ }).click();

    // Posted notes render in .notes-list .note .note-body. We can't
    // pin the exact author (depends on seed user name) but the body
    // we wrote is unique.
    await expect(notesTab.locator(".note-body", { hasText: noteText })).toBeVisible({
      timeout: 5_000,
    });
    // Form clears after submit.
    await expect(input).toHaveValue("");
  });
});

test.describe("ErrorModal — Source tab (test_code path)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Source tab renders the test code block when test_code is present", async ({ page }) => {
    // Mochawesome seed populates test_code for "should login with valid
    // credentials". needsCode: true filters the lookup to the seeded
    // mochawesome run, even if synthetic test runs (live-run, etc.) have
    // a test by that title without test_code.
    const { runId } = await findRunAndTest(page, {
      titleFragment: "should login with valid credentials",
      needsCode: true,
    });
    await openModalForTest(page, runId, "should login with valid credentials");

    // The Source tab only renders when hasCode is true — so its
    // presence is itself part of the assertion.
    const sourceTab = page.locator(".pane-tab", { hasText: /^Source$/ });
    await expect(sourceTab).toBeVisible();
    await sourceTab.click();
    await expect(sourceTab).toHaveClass(/active/);

    // The seed code starts with `it('should login with valid credentials'`.
    const codeBlock = page.locator(".code-panel pre code, .code-block code, pre.code-block").first();
    await expect(codeBlock).toBeVisible({ timeout: 2_000 });
    await expect(codeBlock).toContainText("should login with valid credentials");
    await expect(codeBlock).toContainText("cy.visit('/login')");
  });
});

test.describe("ErrorModal — Details tab (metadata path)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Details tab surfaces retry history + annotations + stdout", async ({ page }) => {
    // The Playwright SSO test has retries (1 fail, 1 pass), tags
    // (@auth, @sso), annotations (slow), stdout entries, location —
    // all under the `metadata` column. Pin the lookup to the seeded
    // record by requiring metadata present.
    const { runId } = await findRunAndTest(page, {
      titleFragment: "should handle SSO redirect",
      needsMetadata: true,
    });
    await openModalForTest(page, runId, "should handle SSO redirect");

    const detailsTab = page.locator(".pane-tab", { hasText: /^Details$/ });
    // hasMetadata gate must be true for this tab to render.
    await expect(detailsTab).toBeVisible();
    await detailsTab.click();
    await expect(detailsTab).toHaveClass(/active/);

    const panel = page.locator(".details-panel");
    await expect(panel).toBeVisible({ timeout: 2_000 });

    // Retry history — 2 attempts in seed.
    await expect(panel.locator(".retry-timeline")).toBeVisible({ timeout: 2_000 });
    await expect(panel.locator(".retry-row")).toHaveCount(2);
    await expect(panel).toContainText("Navigation timeout");

    // Annotation: type "slow" with description.
    await expect(panel).toContainText("slow");
    await expect(panel).toContainText("involves external SSO provider redirect");

    // stdout entries from seed.
    await expect(panel).toContainText("SSO redirect initiated");
  });
});
