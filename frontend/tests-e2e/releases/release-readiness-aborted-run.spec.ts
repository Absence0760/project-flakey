import { expect, test } from "../fixtures/test";
import {
  abortRun,
  autoChecklistItem,
  createRelease,
  CRITICAL_ITEM,
  deleteRelease,
  deleteRun,
  getReadiness,
  getToken,
  gotoReleaseReady,
  linkRun,
  startLiveRun,
} from "./release-helpers";

/**
 * /releases/<id> — an ABORTED run blocks readiness even with zero failures.
 *
 * INVARIANT PROTECTED
 * ===================
 * evaluateCriticalTestsPassing() (backend/src/routes/releases.ts) treats a
 * linked run that has a `run.aborted` live_event as UNRESOLVED — "rerun
 * required" — regardless of its captured pass/fail counts. The captured stats
 * of an aborted run reflect only what landed before the process died (a CI
 * kill / OOM / network drop), so "0 failed" there is NOT a real green. A
 * regression that let an aborted run satisfy the critical-tests rule would
 * green-light a release on a run that never actually finished — a false ship
 * signal. The abort check runs BEFORE the failed-count check precisely so a
 * killed run can't pass on incomplete numbers.
 *
 * This spec starts a live run, aborts it (a real persisted `run.aborted`
 * event), links it, and asserts the critical rule is UNMET with an
 * "aborted / rerun" detail and sign-off stays blocked.
 *
 * WHY A LIVE RUN: abortRun() guards on liveEvents.hasRun(), so it only acts on
 * a run that went through POST /live/start — a /runs/upload run was never live
 * and the abort would no-op. So this exercises the real lifecycle.
 *
 * DETERMINISM: API-driven setup in the worker's tenant. Cold load gated on
 * data-ready; the verdict is asserted from both the readiness JSON and the DOM.
 */
test.describe("/releases/<id> — aborted run blocks despite no failures", () => {
  test("an aborted live run leaves the critical rule unmet (rerun required)", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e aborted run");
    // A live run that gets killed before finishing — no failures recorded.
    const runId = await startLiveRun(page, token);

    try {
      await abortRun(page, token, runId);
      await linkRun(page, token, releaseId, runId);

      // The abort overrides the (absent) failure count: rule unmet, detail abort.
      const readiness = await getReadiness(page, token, releaseId);
      expect(readiness.runs.linked).toBe(1);
      expect(readiness.runs.failed).toBe(0); // no failures recorded…
      expect(readiness.rules.critical_tests_passing.met, "aborted run must not satisfy the rule").toBe(false);
      expect(readiness.rules.critical_tests_passing.details.toLowerCase()).toContain("abort");

      await gotoReleaseReady(page, releaseId);

      // Verdict: blocked.
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();
      await expect(page.locator("section.readiness .ready-pill")).toHaveCount(0);

      // The critical rule renders (an aborted result has no failing_items, so
      // it's a static div.rule, not the expandable details.rule), is NOT met,
      // and its detail explains the abort.
      const criticalRule = page
        .locator("section.readiness .rule")
        .filter({ has: page.locator(".rule-name", { hasText: "critical tests passing" }) });
      await expect(criticalRule).toHaveCount(1);
      await expect(criticalRule).not.toHaveClass(/\bmet\b/);
      await expect(criticalRule.locator(".rule-detail")).toContainText(/abort|rerun/i);

      // The "All critical tests passing" auto-item stays unchecked.
      const critical = autoChecklistItem(page, CRITICAL_ITEM);
      await expect(critical.locator('input[type="checkbox"]')).not.toBeChecked();

      // Sign-off remains gated.
      const signOff = page.locator("section.actions-section button.btn-primary", {
        hasText: "Sign off release",
      });
      await expect(signOff).toBeDisabled();
    } finally {
      await deleteRelease(page, token, releaseId);
      await deleteRun(page, token, runId);
    }
  });
});
