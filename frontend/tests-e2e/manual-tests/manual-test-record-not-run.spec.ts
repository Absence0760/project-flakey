import { expect, test, type Page } from "../fixtures/test";

/**
 * POST /manual-tests/:id/result — recording 'not_run' is rejected.
 *
 * REGRESSION GUARD (bug fixed in manual-tests.ts)
 * ===============================================
 * `not_run` is a valid stored status for a manual test, but the run-history
 * table (manual_test_runs) has a CHECK that excludes it. The result endpoint
 * accepted 'not_run', committed the manual_tests UPDATE, then 500'd on the
 * history INSERT — a partial write: the test's status flipped to 'not_run'
 * with no history row, and the caller got a 500. Recording a result means an
 * execution happened, so 'not_run' (the absence of one) is now rejected up
 * front, before any write.
 *
 * DETERMINISM: API-driven in the worker's own tenant.
 */
const API = "http://localhost:3000";

async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!t) throw new Error("bt_token missing");
  return t;
}
function hdrs(t: string) {
  return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
}

test.describe("manual-tests — record result rejects not_run", () => {
  test("a 'not_run' record is refused and does not revert a prior status", async ({ page }) => {
    await page.goto("/dashboard");
    const t = await token(page);

    const created = await page.request.post(`${API}/manual-tests`, {
      headers: hdrs(t),
      data: { title: `e2e not_run guard ${Date.now()}`, priority: "high" },
    });
    expect(created.status()).toBeLessThan(400);
    const id = (await created.json()).id as number;

    try {
      // A real execution records fine.
      const pass = await page.request.post(`${API}/manual-tests/${id}/result`, {
        headers: hdrs(t),
        data: { status: "passed" },
      });
      expect(pass.status(), "recording 'passed' succeeds").toBeLessThan(400);

      // 'not_run' is rejected with 400 (no 500, no partial write).
      const notRun = await page.request.post(`${API}/manual-tests/${id}/result`, {
        headers: hdrs(t),
        data: { status: "not_run" },
      });
      expect(notRun.status(), "recording 'not_run' is rejected").toBe(400);

      // The prior status is intact — the rejected call wrote nothing.
      const get = await page.request.get(`${API}/manual-tests/${id}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      expect(get.ok()).toBeTruthy();
      expect((await get.json()).status, "status stayed 'passed'").toBe("passed");
    } finally {
      await page.request
        .delete(`${API}/manual-tests/${id}`, { headers: { Authorization: `Bearer ${t}` } })
        .catch(() => {});
    }
  });
});
