import { expect, test, type Page } from "../fixtures/test";

/**
 * manual-tests — mutating a non-existent id returns 404, not a misleading 200.
 *
 * REGRESSION GUARD (bugs fixed across manual-test* routes)
 * ========================================================
 * PATCH/DELETE on manual-test groups, tests, and requirements ran their
 * UPDATE/DELETE without checking rowCount, so a request against a non-existent
 * (or another org's, RLS-invisible) id returned 200 "{deleted/updated:true}"
 * and logged a phantom audit event — claiming success for a no-op. They now
 * use RETURNING and 404 when nothing matched.
 *
 * DETERMINISM: API-driven; a deliberately out-of-range id (no setup needed).
 */
const API = "http://localhost:3000";
const BOGUS = 2_000_000_000;

async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!t) throw new Error("bt_token missing");
  return t;
}
function hdrs(t: string) {
  return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
}

test.describe("manual-tests — not-found mutations return 404", () => {
  test("DELETE a non-existent manual test → 404", async ({ page }) => {
    await page.goto("/dashboard");
    const t = await token(page);
    const res = await page.request.delete(`${API}/manual-tests/${BOGUS}`, { headers: hdrs(t) });
    expect(res.status()).toBe(404);
  });

  test("PATCH and DELETE a non-existent group → 404", async ({ page }) => {
    await page.goto("/dashboard");
    const t = await token(page);

    const patch = await page.request.patch(`${API}/manual-test-groups/${BOGUS}`, {
      headers: hdrs(t),
      data: { name: "ghost group" },
    });
    expect(patch.status(), "PATCH phantom group is 404").toBe(404);

    const del = await page.request.delete(`${API}/manual-test-groups/${BOGUS}`, { headers: hdrs(t) });
    expect(del.status(), "DELETE phantom group is 404").toBe(404);
  });

  test("DELETE a non-existent requirement on a real test → 404", async ({ page }) => {
    await page.goto("/dashboard");
    const t = await token(page);

    // A real parent test, but a bogus requirement id under it.
    const created = await page.request.post(`${API}/manual-tests`, {
      headers: hdrs(t),
      data: { title: `e2e req-404 parent ${Date.now()}`, priority: "low" },
    });
    expect(created.status()).toBeLessThan(400);
    const testId = (await created.json()).id as number;

    try {
      const del = await page.request.delete(
        `${API}/manual-tests/${testId}/requirements/${BOGUS}`,
        { headers: hdrs(t) },
      );
      expect(del.status(), "DELETE phantom requirement is 404").toBe(404);
    } finally {
      await page.request
        .delete(`${API}/manual-tests/${testId}`, { headers: { Authorization: `Bearer ${t}` } })
        .catch(() => {});
    }
  });
});
