import { expect, test } from "../fixtures/test";
import {
  createManualTest,
  createRelease,
  deleteRelease,
  deleteRun,
  getReadiness,
  getToken,
  gotoReleaseReady,
  linkManualTest,
  linkRun,
  recordResult,
  startLiveRun,
  startSession,
  unlinkManualTest,
} from "./release-helpers";

/**
 * /releases/<id> — readiness must not report false signals.
 *
 * Two correctness bugs fixed in releases.ts, guarded here:
 *
 * 1. LIVE/IN-PROGRESS RUN FALSE GREEN. evaluateCriticalTestsPassing checked
 *    `aborted` and `failed` but not `finished_at`. A running (not-yet-finished)
 *    linked run has failed=0 simply because nothing has failed YET — so the
 *    rule reported "passing" and could green-light a release mid-run. The fix
 *    treats an unfinished run as "still in progress" (mirrors the run-status
 *    definition: passing ⇔ finished_at IS NOT NULL AND failed=0 AND NOT
 *    aborted).
 *
 * 2. STALE SESSION ROWS FROM UNLINKED TESTS. The manual rule + readiness card
 *    counted session_result rows with no join back to release_manual_tests. A
 *    test unlinked AFTER a session was seeded left its row behind — a leftover
 *    not_run blocked the rule forever; a leftover pass inflated the count. The
 *    fix joins release_manual_tests so only currently-linked tests count.
 *
 * DETERMINISM: API-driven setup in the worker's tenant; readiness JSON is the
 * oracle, with a DOM confirmation gated on data-ready.
 */
test.describe("/releases/<id> — readiness correctness", () => {
  test("a linked live (unfinished) run does not satisfy the critical-tests rule", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e live-run gate");
    // A live run that has NOT finished and was NOT aborted — failed=0 only
    // because nothing has run yet.
    const runId = await startLiveRun(page, token);

    try {
      await linkRun(page, token, releaseId, runId);

      const readiness = await getReadiness(page, token, releaseId);
      expect(readiness.runs.linked).toBe(1);
      expect(readiness.runs.failed).toBe(0); // no failures…
      expect(
        readiness.rules.critical_tests_passing.met,
        "an unfinished run is not a pass",
      ).toBe(false);
      expect(readiness.rules.critical_tests_passing.details.toLowerCase()).toContain("in progress");

      await gotoReleaseReady(page, releaseId);
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();
      const criticalRule = page
        .locator("section.readiness .rule")
        .filter({ has: page.locator(".rule-name", { hasText: "critical tests passing" }) });
      await expect(criticalRule).not.toHaveClass(/\bmet\b/);
      await expect(criticalRule.locator(".rule-detail")).toContainText(/in progress/i);
    } finally {
      await deleteRelease(page, token, releaseId);
      await deleteRun(page, token, runId);
    }
  });

  test("unlinking a manual test drops its stale session row from readiness", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e unlink stale rows");
    const keep = await createManualTest(page, token, `e2e keep ${Date.now()}`);
    const drop = await createManualTest(page, token, `e2e drop ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, keep);
      await linkManualTest(page, token, releaseId, drop);

      const sessionId = await startSession(page, token, releaseId);
      // Execute `keep`; leave `drop` not_run so the session stays in_progress
      // and `drop` is a leftover not_run row.
      await recordResult(page, token, releaseId, sessionId, keep, "passed");

      // Before unlink: `drop` is a not_run failing item and is counted.
      const before = await getReadiness(page, token, releaseId);
      expect(before.manual_tests.linked, "both rows counted before unlink").toBe(2);
      const droppedBefore = (before.rules.manual_regression_executed.failing_items ?? []).filter(
        (it: any) => it.test_id === drop,
      );
      expect(droppedBefore, "drop blocks readiness before unlink").toHaveLength(1);

      // Unlink `drop`. Its session_result row persists in the DB.
      await unlinkManualTest(page, token, releaseId, drop);

      // After unlink: `drop`'s stale row must NOT count any more.
      const after = await getReadiness(page, token, releaseId);
      expect(after.manual_tests.linked, "only the still-linked row counts").toBe(1);
      const droppedAfter = (after.rules.manual_regression_executed.failing_items ?? []).filter(
        (it: any) => it.test_id === drop,
      );
      expect(droppedAfter, "unlinked test no longer blocks readiness").toHaveLength(0);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
