import { expect, test } from "../fixtures/test";
import {
  autoChecklistItem,
  createManualTest,
  createRelease,
  deleteRelease,
  getReadiness,
  getToken,
  gotoReleaseReady,
  linkManualTest,
  MANUAL_ITEM,
  recordResult,
  startSession,
} from "./release-helpers";

/**
 * /releases/<id> — non-FAILED statuses block readiness too.
 *
 * INVARIANT PROTECTED
 * ===================
 * The manual-regression rule (evaluateManualRegressionExecuted) blocks on more
 * than just `failed`. Two often-forgotten states must also keep the rule unmet
 * and surface as failing items with the right status styling:
 *   - `blocked`  — a test that couldn't be executed (env down, dependency
 *                  broken). Counts as a blocker (unless accepted).
 *   - `not_run`  — a session left partially executed. The release is not ready
 *                  until every linked test has a verdict.
 * A regression that only checked for `failed` would let a release ship with
 * blocked or un-run regression tests. The backend's precedence is
 * failed > blocked > not_run, so we isolate each state in its own session.
 *
 * DETERMINISM: API-driven; each case is its own fresh release. The status pill
 * class is `status-${status.replace('_','-')}` (so not_run → status-not-run).
 */
test.describe("/releases/<id> — blocked and not_run statuses block readiness", () => {
  test("a blocked manual result keeps the rule unmet and shows a blocked status pill", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e blocked status");

    const blockedTest = await createManualTest(page, token, `e2e blocked ${Date.now()}`);
    const passTest = await createManualTest(page, token, `e2e pass ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, blockedTest);
      await linkManualTest(page, token, releaseId, passTest);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, passTest, "passed");
      // Final terminal status auto-completes the session — a clean "completed
      // session with one blocked test" so the rule's blocked-branch fires
      // (not the in-progress branch).
      const last = await recordResult(page, token, releaseId, sessionId, blockedTest, "blocked");
      expect(last.session_completed, "recording the final row completes the session").toBe(true);

      const readiness = await getReadiness(page, token, releaseId);
      expect(readiness.rules.manual_regression_executed.met, "blocked test blocks the rule").toBe(false);
      expect(readiness.rules.manual_regression_executed.details).toContain("blocked");
      const items = readiness.rules.manual_regression_executed.failing_items ?? [];
      expect(items.some((it: any) => it.test_id === blockedTest && it.status === "blocked")).toBe(true);

      await gotoReleaseReady(page, releaseId);
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();

      const manualRule = page
        .locator("section.readiness details.rule")
        .filter({ has: page.locator(".rule-name", { hasText: "manual regression executed" }) });
      await expect(manualRule).toHaveCount(1);
      await expect(manualRule).not.toHaveClass(/\bmet\b/);
      await expect(manualRule.locator(".rule-detail")).toContainText("blocked");
      await manualRule.locator("summary").click();
      // The blocked test renders with a blocked status pill.
      const blockedRow = manualRule.locator("ul.rule-failures > li").filter({
        has: page.locator(".status-pill.status-blocked"),
      });
      await expect(blockedRow).toHaveCount(1);

      await expect(autoChecklistItem(page, MANUAL_ITEM).locator('input[type="checkbox"]')).not.toBeChecked();
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });

  test("a partially-executed session (not_run) keeps the rule unmet with a not-run pill", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e not_run status");

    const runTest = await createManualTest(page, token, `e2e executed ${Date.now()}`);
    const skipTest = await createManualTest(page, token, `e2e leftover ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, runTest);
      await linkManualTest(page, token, releaseId, skipTest);

      const sessionId = await startSession(page, token, releaseId);
      // Record only ONE of the two → the other stays not_run and the session
      // stays in_progress (auto-complete fires only when no not_run remain).
      const rec = await recordResult(page, token, releaseId, sessionId, runTest, "passed");
      expect(rec.session_completed, "session must stay in progress with a not_run row").toBeFalsy();

      const readiness = await getReadiness(page, token, releaseId);
      expect(readiness.rules.manual_regression_executed.met, "an un-run test blocks the rule").toBe(false);
      expect(readiness.rules.manual_regression_executed.details).toContain("not run");
      const items = readiness.rules.manual_regression_executed.failing_items ?? [];
      expect(items.some((it: any) => it.test_id === skipTest && it.status === "not_run")).toBe(true);

      await gotoReleaseReady(page, releaseId);
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();

      const manualRule = page
        .locator("section.readiness details.rule")
        .filter({ has: page.locator(".rule-name", { hasText: "manual regression executed" }) });
      await expect(manualRule).toHaveCount(1);
      await expect(manualRule.locator(".rule-detail")).toContainText("not run");
      await manualRule.locator("summary").click();
      // status_not_run → pill class status-not-run, label "not run".
      const notRunRow = manualRule.locator("ul.rule-failures > li").filter({
        has: page.locator(".status-pill.status-not-run"),
      });
      await expect(notRunRow).toHaveCount(1);

      await expect(autoChecklistItem(page, MANUAL_ITEM).locator('input[type="checkbox"]')).not.toBeChecked();
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
