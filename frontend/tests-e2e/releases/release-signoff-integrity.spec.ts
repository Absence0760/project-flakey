import { expect, test } from "../fixtures/test";
import { API, authHeaders, createRelease, deleteRelease, getToken } from "./release-helpers";

/**
 * /releases/<id> — sign-off cannot be reached by side-doors.
 *
 * REGRESSION GUARDS (two bugs fixed in releases.ts)
 * =================================================
 * 1. PATCH /releases/:id accepted `{ status: "signed_off" }` and applied it
 *    with a plain UPDATE — skipping the checklist gate AND leaving
 *    signed_off_by / signed_off_at null. Sign-off must only happen through
 *    POST /:id/sign-off. The fix drops "signed_off" from the PATCH-able
 *    statuses, so a PATCH attempt no longer changes the release.
 * 2. POST /:id/sign-off had no state guard, so it would sign off a CANCELLED
 *    release (overriding the cancellation) or re-sign an already-signed one
 *    (rewriting the signer/timestamp). The fix 409s unless the release is
 *    draft/in_progress.
 *
 * DETERMINISM: API-driven; assertions read the release back via GET.
 */
async function getRelease(page: any, token: string, id: number): Promise<any> {
  const res = await page.request.get(`${API}/releases/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe("/releases/<id> — sign-off integrity", () => {
  test("PATCH cannot set status=signed_off (must go through the gated endpoint)", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e patch signoff");

    try {
      // Attempt the side-door. The status field is now ignored on PATCH; since
      // it's the only field, the request is a no-op (400 "Nothing to update").
      const res = await page.request.patch(`${API}/releases/${releaseId}`, {
        headers: authHeaders(token),
        data: { status: "signed_off" },
      });
      expect(res.status(), "PATCH signed_off is rejected as a no-op").toBe(400);

      // The release must NOT be signed off, and must have no signer/timestamp.
      const rel = await getRelease(page, token, releaseId);
      expect(rel.status, "status unchanged").not.toBe("signed_off");
      expect(rel.signed_off_at, "no sign-off timestamp").toBeFalsy();
      expect(rel.signed_off_by, "no signer").toBeFalsy();
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });

  test("sign-off is refused on a release that isn't in a signable state", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token, "e2e signoff state guard");

    try {
      // Cancel it (a legitimate PATCH status change).
      const cancel = await page.request.patch(`${API}/releases/${releaseId}`, {
        headers: authHeaders(token),
        data: { status: "cancelled" },
      });
      expect(cancel.status(), "cancel succeeds").toBeLessThan(400);

      // Signing off a cancelled release is refused with 409 — and crucially
      // BEFORE any checklist evaluation, so it doesn't matter that items are
      // unchecked.
      const signOff = await page.request.post(`${API}/releases/${releaseId}/sign-off`, {
        headers: authHeaders(token),
      });
      expect(signOff.status(), "sign-off on a cancelled release is 409").toBe(409);

      const rel = await getRelease(page, token, releaseId);
      expect(rel.status, "still cancelled — not overridden").toBe("cancelled");
      expect(rel.signed_off_at).toBeFalsy();
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
