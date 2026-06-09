import { expect, test } from "../fixtures/test";
import {
  acceptResult,
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
 * /releases/<id> — re-recording a result CLEARS a prior known-issue acceptance.
 *
 * REGRESSION GUARD (bug fixed in releases.ts: POST .../results/:testId)
 * ====================================================================
 * Accepting a failed/blocked result as a known issue stops it counting as a
 * release blocker. But acceptance is tied to ONE observed result — re-running
 * the test is a fresh verdict. The record endpoint used to leave
 * `accepted_as_known_issue = TRUE` on a re-record, so a result accepted for
 * failure A, then re-run and failing again for reason B, silently inherited the
 * old deferral: the new failure never re-counted as a blocker and dropped out
 * of failures-only reruns. That hides a brand-new regression behind a stale
 * acceptance — exactly what the readiness gate exists to catch.
 *
 * The fix clears the acceptance fields on every re-record. These specs lock it
 * in from both directions: a re-failure must block again, and a re-pass must
 * not linger as "accepted".
 *
 * SETUP NOTE: two tests are linked; the second is left `not_run` so the session
 * stays in_progress and the first test can be re-recorded (a completed session
 * rejects further writes with 409). Assertions target the FIRST test only.
 *
 * DETERMINISM: API-driven; the readiness JSON is the precise oracle, with a DOM
 * confirmation gated on data-ready.
 */
test.describe("/releases/<id> — re-record clears known-issue acceptance", () => {
  test("a re-failure after acceptance blocks the release again", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e re-record refail");

    const target = await createManualTest(page, token, `e2e rerecord target ${Date.now()}`);
    const keepOpen = await createManualTest(page, token, `e2e keep-open ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, target);
      await linkManualTest(page, token, releaseId, keepOpen);

      const sessionId = await startSession(page, token, releaseId);
      // Record only `target`; `keepOpen` stays not_run → session in_progress.
      const rec = await recordResult(page, token, releaseId, sessionId, target, "failed");
      expect(rec.session_completed, "session stays open with a not_run row").toBeFalsy();

      // Accept the failure → it's deferred, no longer a failing blocker.
      await acceptResult(page, token, releaseId, sessionId, target, "ACME-900");
      const accepted = await getReadiness(page, token, releaseId);
      expect(accepted.manual_tests.accepted, "target is accepted").toBe(1);
      const acceptedFails = (accepted.rules.manual_regression_executed.failing_items ?? []).filter(
        (it: any) => it.test_id === target && it.status === "failed",
      );
      expect(acceptedFails, "accepted failure is not listed as a failing blocker").toHaveLength(0);

      // Re-record the SAME test as failed again (a different real failure).
      await recordResult(page, token, releaseId, sessionId, target, "failed");

      // The acceptance must be GONE: it counts as a blocker once more.
      const after = await getReadiness(page, token, releaseId);
      expect(after.manual_tests.accepted, "re-record cleared the acceptance").toBe(0);
      expect(after.rules.manual_regression_executed.met, "the fresh failure blocks again").toBe(false);
      const reFails = (after.rules.manual_regression_executed.failing_items ?? []).filter(
        (it: any) => it.test_id === target && it.status === "failed",
      );
      expect(reFails, "the re-failed test is a failing blocker again").toHaveLength(1);

      // DOM confirmation: blocked, and the target shows as a failed failing item.
      await gotoReleaseReady(page, releaseId);
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();
      const manualRule = page
        .locator("section.readiness details.rule")
        .filter({ has: page.locator(".rule-name", { hasText: "manual regression executed" }) });
      await manualRule.locator("summary").click();
      await expect(
        manualRule.locator("ul.rule-failures > li").filter({
          has: page.locator(".status-pill.status-failed"),
        }),
      ).toHaveCount(1);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });

  test("a re-pass after acceptance does not linger as an accepted known issue", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e re-record repass");

    const target = await createManualTest(page, token, `e2e rerecord pass ${Date.now()}`);
    const keepOpen = await createManualTest(page, token, `e2e keep-open ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, target);
      await linkManualTest(page, token, releaseId, keepOpen);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, target, "failed");
      await acceptResult(page, token, releaseId, sessionId, target, "ACME-901");
      expect((await getReadiness(page, token, releaseId)).manual_tests.accepted).toBe(1);

      // Re-run and it now passes → acceptance is meaningless and must clear.
      await recordResult(page, token, releaseId, sessionId, target, "passed");

      const after = await getReadiness(page, token, releaseId);
      expect(after.manual_tests.accepted, "a now-passing test is not 'accepted'").toBe(0);
      expect(after.manual_tests.passed, "the re-pass is counted as passed").toBeGreaterThanOrEqual(1);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
