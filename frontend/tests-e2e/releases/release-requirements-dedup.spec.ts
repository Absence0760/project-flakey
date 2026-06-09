import { expect, test } from "../fixtures/test";
import {
  attachRequirement,
  createManualTest,
  createRelease,
  deleteRelease,
  getRequirements,
  getToken,
  linkManualTest,
} from "./release-helpers";

/**
 * /releases/<id>/requirements — one ticket = one coverage row.
 *
 * REGRESSION GUARD (bug fixed in releases.ts requirements rollup)
 * ==============================================================
 * The coverage GROUP BY keyed on (ref_key, ref_url, ref_title, provider). Two
 * tests may label the SAME ticket (ref_key) with different titles — the UNIQUE
 * constraint is per (manual_test_id, ref_key), not org-wide. Grouping on title
 * too split one logical ticket into multiple rows, each with partial counts
 * (the ticket appeared to be covered "1/1" twice instead of "2/2"). The fix
 * groups by ticket identity (ref_key + provider). This locks in a single row
 * with the full count.
 *
 * DETERMINISM: API-driven; unique per-run ref_key avoids any collision.
 */
test.describe("/releases/<id> — requirements coverage de-duplicates a ticket", () => {
  test("the same ref_key with different titles across tests rolls into one row", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e req dedup");
    const refKey = `REQ-DEDUP-${Date.now().toString(36)}`.toUpperCase();

    const t1 = await createManualTest(page, token, `e2e dedup t1 ${Date.now()}`);
    const t2 = await createManualTest(page, token, `e2e dedup t2 ${Date.now()}`);

    try {
      // SAME ref_key, DIFFERENT titles — the trigger for the old double-count.
      await attachRequirement(page, token, t1, refKey, "Login works (per t1)");
      await attachRequirement(page, token, t2, refKey, "Auth path (per t2)");
      await linkManualTest(page, token, releaseId, t1);
      await linkManualTest(page, token, releaseId, t2);

      const rows = await getRequirements(page, token, releaseId);
      const forKey = rows.filter((r: any) => r.ref_key === refKey);
      expect(forKey, "the ticket appears exactly once").toHaveLength(1);
      expect(forKey[0].total, "both tests count toward the one ticket").toBe(2);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
