import { expect, test } from "../fixtures/test";
import { findRunAndTest, openModalForTest } from "./error-modal-helpers";


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
 * to be at the top of a run. Shared lookup/open helpers live in
 * ./error-modal-helpers.
 */

test.describe("ErrorModal — Info / History / Notes (always-present tabs)", () => {

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
    // and rightTab still defaults to "commands". Click into Info.
    await page.locator(".pane-tab", { hasText: /^Info$/ }).click();
    await expect(page.locator(".info-panel")).toBeVisible({ timeout: 2_000 });

    // Detail rows: Test, Spec, Status, Duration, Run.
    const detailRows = page.locator(".info-panel .detail-row");
    await expect(detailRows).toHaveCount(5);
    await expect(detailRows.filter({ hasText: "Status" }).locator(".info-status")).toHaveText(
      "failed",
    );

    // The error block was lifted out of the Info tab into a persistent
    // band above .pane-tabs (so the error is always visible regardless
    // of which tab is selected). Selector is now `.error-block
    // .error-msg`, not `.info-panel .error-msg`.
    await expect(page.locator(".error-block .error-msg")).toContainText(
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

  test("first tab switch does not reset modal state (regression: loadTest re-run)", async ({ page }) => {
    // Regression for the "first click resets the modal" glitch. The
    // testId $effect synchronously read historyLoaded/history inside
    // loadTest, so the FIRST History click (which sets historyLoaded)
    // re-triggered the effect → loadTest ran again → it cleared
    // collapsedGroups / currentScreenshot / leftTab. Subsequent clicks
    // were fine because historyLoaded was already true. We assert a
    // user-set Commands-tab collapse survives the first History click.
    const { runId } = await findRunAndTest(page, {
      titleFragment: "Gherkin demo",
      needsCommandLog: true,
    });
    await openModalForTest(page, runId, "Login with valid credentials (Gherkin demo)");

    // Commands is the default right tab for the gherkin (snapshot) test.
    await page.locator(".pane-tab", { hasText: /^Commands/ }).click();
    const firstGroup = page.locator(".command-list .cmd-gherkin").first();
    await expect(firstGroup).toBeVisible({ timeout: 2_000 });

    // Group starts open (▾). Collapse it (▸) — this is the user-set
    // state that the glitch wiped.
    await expect(firstGroup.locator(".cmd-chevron")).toHaveText("▾");
    await firstGroup.click();
    await expect(firstGroup.locator(".cmd-chevron")).toHaveText("▸");

    // First-ever History click — the trigger for the old reset.
    const historyTab = page.locator(".pane-tab", { hasText: /^History$/ });
    await historyTab.click();
    await expect(historyTab).toHaveClass(/active/);
    await expect(page.locator(".history-timeline")).toBeVisible({ timeout: 5_000 });

    // Back to Commands — the collapse must still be there. Pre-fix,
    // loadTest had cleared collapsedGroups and this chevron read "▾".
    await page.locator(".pane-tab", { hasText: /^Commands/ }).click();
    await expect(firstGroup.locator(".cmd-chevron")).toHaveText("▸");
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
