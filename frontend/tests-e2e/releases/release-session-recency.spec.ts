import { expect, test } from "../fixtures/test";
import {
  createManualTest,
  createRelease,
  deleteRelease,
  getReadiness,
  getToken,
  gotoReleaseReady,
  linkManualTest,
  recordResult,
  startSession,
} from "./release-helpers";

/**
 * /releases/<id> — readiness tracks the MOST-RECENT session, not history.
 *
 * INVARIANT PROTECTED
 * ===================
 * evaluateManualRegressionExecuted() evaluates the latest session
 * (ORDER BY session_number DESC LIMIT 1). A team that ran a clean regression
 * cycle, then opened a NEW cycle and hit a failure, must see the release flip
 * back to blocked — the rule must not "remember" the earlier green and let a
 * fresh failure slip through. This is the bug that makes a dashboard lie: a
 * stale pass masking a current failure.
 *
 * Flow: link one manual test.
 *   Session 1: record passed → auto-completes → manual rule MET.
 *   Session 2 (a fresh cycle): record failed → auto-completes → because it is
 *   now the most-recent session, the manual rule flips back to UNMET and the
 *   detail references session #2.
 *
 * DETERMINISM: a second session is allowed only once the first is closed; the
 * single-test sessions auto-complete on their one record, guaranteeing the
 * ordering. Asserted from the readiness JSON (met true→false) and the DOM.
 */
test.describe("/releases/<id> — manual rule follows the latest session", () => {
  test("a clean session goes green, then a newer failing session flips it back to blocked", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e session recency");
    const testId = await createManualTest(page, token, `e2e recency mt ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, testId);

      // ── Session 1: clean pass → rule MET ───────────────────────────
      const s1 = await startSession(page, token, releaseId);
      const r1 = await recordResult(page, token, releaseId, s1, testId, "passed");
      expect(r1.session_completed, "single-test session auto-completes").toBe(true);

      const afterClean = await getReadiness(page, token, releaseId);
      expect(afterClean.rules.manual_regression_executed.met, "clean completed session is met").toBe(true);

      // ── Session 2: a fresh cycle that fails → rule flips back UNMET ──
      const s2 = await startSession(page, token, releaseId);
      expect(s2, "second session id differs from the first").not.toBe(s1);
      const r2 = await recordResult(page, token, releaseId, s2, testId, "failed");
      expect(r2.session_completed).toBe(true);

      const afterFail = await getReadiness(page, token, releaseId);
      expect(
        afterFail.rules.manual_regression_executed.met,
        "the newer failing session must override the earlier green",
      ).toBe(false);
      // The detail references the latest session, and the failed test is listed.
      expect(afterFail.rules.manual_regression_executed.details).toContain("failing");
      const items = afterFail.rules.manual_regression_executed.failing_items ?? [];
      expect(items.some((it: any) => it.test_id === testId && it.status === "failed")).toBe(true);

      // DOM confirmation: the release reads as blocked after session 2.
      await gotoReleaseReady(page, releaseId);
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();
      const manualRule = page
        .locator("section.readiness details.rule")
        .filter({ has: page.locator(".rule-name", { hasText: "manual regression executed" }) });
      await expect(manualRule).toHaveCount(1);
      await expect(manualRule).not.toHaveClass(/\bmet\b/);
      await expect(manualRule.locator(".rule-detail")).toContainText("failing");
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
