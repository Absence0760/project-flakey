import { expect, test } from "../fixtures/test";
import {
  assignTester,
  createManualTest,
  createRelease,
  deleteRelease,
  getMyUserId,
  getSessionDetail,
  getToken,
  linkManualTest,
  recordResult,
  startSession,
} from "./release-helpers";

/**
 * /releases/<id>/.../assign — only org members can be assigned (IDOR guard).
 *
 * SECURITY REGRESSION GUARD (bug fixed in releases.ts assign endpoint)
 * ====================================================================
 * `release_test_session_results.assigned_to` stores a user id, and the session
 * detail GET joins `users` to return `assigned_to_email`. `users` has no RLS.
 * The assign endpoint used to write ANY integer user id with no membership
 * check, so an admin in org A could write a guessed id and read back a
 * cross-org user's email — a tenant-boundary PII leak (SOC 2 / GovRAMP).
 *
 * The fix rejects a user id that isn't a member of the caller's org. These
 * specs lock it from both sides: a non-member id is refused; a real member
 * (the signed-in admin) assigns fine and round-trips their email.
 *
 * DETERMINISM: API-driven in the worker's own tenant.
 */
test.describe("/releases/<id> — assign requires org membership", () => {
  test("a non-member user id is rejected; a real member assigns and round-trips", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const myId = await getMyUserId(page, token);
    const releaseId = await createRelease(page, token, "e2e assign membership");
    const testId = await createManualTest(page, token, `e2e assign mt ${Date.now()}`);

    try {
      await linkManualTest(page, token, releaseId, testId);
      const sessionId = await startSession(page, token, releaseId);
      // A result row must exist for the assign UPDATE to target.
      await recordResult(page, token, releaseId, sessionId, testId, "passed");

      // A user id that is not a member of this org is refused (closes the leak).
      const bogus = await assignTester(page, token, releaseId, sessionId, testId, 2_000_000_000);
      expect(bogus.status(), "non-member assign is rejected").toBe(400);

      // The signed-in admin IS a member → assign succeeds and round-trips email.
      const ok = await assignTester(page, token, releaseId, sessionId, testId, myId);
      expect(ok.status(), "member assign succeeds").toBeLessThan(400);

      const detail = await getSessionDetail(page, token, releaseId, sessionId);
      const row = (detail.results ?? []).find((r: any) => r.manual_test_id === testId);
      expect(row, "the result row is present").toBeTruthy();
      expect(row.assigned_to, "assigned to my own id").toBe(myId);
      expect(row.assigned_to_email, "email round-trips for a member").toBeTruthy();

      // Un-assign (null) is always allowed.
      const clear = await assignTester(page, token, releaseId, sessionId, testId, null);
      expect(clear.status(), "un-assign is allowed").toBeLessThan(400);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
