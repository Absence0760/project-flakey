import { expect, test } from "../fixtures/test";
import {
  createRelease,
  deleteRelease,
  getReadiness,
  getToken,
  gotoReleaseReady,
} from "./release-helpers";

/**
 * /releases/<id> — readiness FALLBACK when nothing is explicitly linked.
 *
 * INVARIANT PROTECTED
 * ===================
 * A release with no linked runs and no linked manual tests must not show an
 * empty/broken readiness panel. The backend rules fall back to a signal so the
 * gate still means something:
 *   - critical-tests rule → the org's single most-recent run;
 *   - manual-regression rule → the org's high/critical priority manual tests.
 * The UI must communicate that it's running on fallbacks (not a curated set),
 * so the reader knows the readiness is approximate until they link artifacts.
 *
 * This asserts the FALLBACK AFFORDANCE deterministically: readiness JSON
 * reports zero linked artifacts, and both readiness cards render the
 * "falling back…" copy. It deliberately does NOT assert the ready/blocked
 * verdict — that depends on the worker tenant's seeded latest-run/priority-test
 * state, which is not ours to pin here (asserting it would be a seed-coupled
 * flake). The point is the fallback path renders, not which way it resolves.
 *
 * DETERMINISM: fresh release, link nothing. Cold load gated on data-ready.
 */
test.describe("/releases/<id> — readiness fallback (nothing linked)", () => {
  test("unlinked release surfaces the fallback messaging on both readiness cards", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e fallback");

    try {
      const readiness = await getReadiness(page, token, releaseId);
      expect(readiness.runs.linked, "no runs linked").toBe(0);
      expect(readiness.manual_tests.linked, "no manual tests linked").toBe(0);

      await gotoReleaseReady(page, releaseId);

      // The readiness panel still renders a verdict (we don't assert which).
      await expect(
        page.locator("section.readiness .ready-pill, section.readiness .blocked-pill"),
      ).toBeVisible();

      // Automated-runs card: fallback copy, no card-big count (linked === 0).
      const runsCard = page.locator("section.readiness .readiness-card", {
        has: page.locator(".card-title", { hasText: "Automated runs" }),
      });
      await expect(runsCard.locator(".card-sub")).toContainText("No runs linked yet");
      await expect(runsCard.locator(".card-sub")).toContainText("falling back to latest run");
      await expect(runsCard.locator(".card-big")).toHaveCount(0);

      // Manual-tests card: fallback copy.
      const manualCard = page.locator("section.readiness .readiness-card", {
        has: page.locator(".card-title", { hasText: "Manual tests" }),
      });
      await expect(manualCard.locator(".card-sub")).toContainText("No manual tests linked");
      await expect(manualCard.locator(".card-sub")).toContainText("high/critical priority");
      await expect(manualCard.locator(".card-big")).toHaveCount(0);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
