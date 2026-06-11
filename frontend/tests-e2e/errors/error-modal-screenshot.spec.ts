import { expect, test, type APIRequestContext, type Page } from "../fixtures/test";

/**
 * ErrorModal — Screenshots tab decodes (CSP img-src regression).
 *
 * Artifacts (screenshots) are <img> elements served from the API origin —
 * a DIFFERENT origin from the SPA (:3000 vs :7778 in dev; api.* vs the
 * CloudFront host in prod). The CSP allow-listed the API origin in
 * connect-src (so fetch/data worked and the page rendered) but NOT in
 * img-src, so every screenshot was silently blocked with a CSP "img-src"
 * violation and showed a broken-image icon.
 *
 * A CSP-blocked <img> still mounts and is "visible" — its naturalWidth is
 * 0. So visibility is not enough; we assert the image actually DECODED
 * (naturalWidth > 0), which is what the user sees as "the screenshot
 * loaded". See frontend/svelte.config.js (kit.csp.directives.img-src) and
 * infra/modules/s3/main.tf (the prod CloudFront CSP).
 *
 * Self-contained: it creates its own run + uploads a real screenshot, so it
 * doesn't depend on whether the seed's on-disk artifacts survived in the
 * current dev DB. Runs in the per-worker tenant like every other spec.
 */

// 1x1 PNG — decodes to naturalWidth 1 (> 0); a CSP block leaves it at 0.
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const API = "http://localhost:3000";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function postEvent(
  request: APIRequestContext,
  token: string,
  runId: number,
  event: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${API}/live/${runId}/events`, {
    headers: { ...auth(token), "Content-Type": "application/json" },
    data: event,
  });
  expect(res.status(), `event ${event.type} should accept`).toBe(200);
}

test.describe("ErrorModal — Screenshots tab", () => {
  test("a failed test's screenshot actually decodes (not CSP-blocked)", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const suite = `shot-csp-${Date.now().toString(36)}`;
    const specPath = "tests/csp/screenshot.spec.ts";
    const fullTitle = "screenshot renders in the error modal";

    // Create a run with one failed test.
    const startRes = await page.request.post(`${API}/live/start`, {
      headers: { ...auth(token), "Content-Type": "application/json" },
      data: { suite, branch: "main", commitSha: "csp-regression" },
    });
    expect(startRes.status(), "POST /live/start").toBe(201);
    const runId = (await startRes.json()).id as number;

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: fullTitle });
    await postEvent(page.request, token, runId, {
      type: "test.failed", spec: specPath, test: fullTitle, duration_ms: 50,
      error: { message: "intentional failure to attach a screenshot" },
    });

    // Upload a real screenshot — writes the file to storage AND attaches its
    // key to the test row. This is the artifact the <img> will request.
    const ssRes = await page.request.post(`${API}/live/${runId}/screenshot`, {
      headers: auth(token),
      multipart: {
        screenshot: { name: "evidence.png", mimeType: "image/png", buffer: MINIMAL_PNG },
        spec: specPath,
        testTitle: fullTitle,
      },
    });
    expect(ssRes.status(), "screenshot upload should accept").toBe(200);
    await postEvent(page.request, token, runId, { type: "run.finished" });

    try {
      // Open the run detail, expand specs, open the failed test modal.
      await page.goto(`/runs/${runId}?status=all`);
      await expect(
        page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
      ).toBeVisible({ timeout: 10_000 });

      const testButton = page.getByRole("button", { name: fullTitle, exact: true });
      if (!(await testButton.first().isVisible().catch(() => false))) {
        const specHeaders = page.locator(".spec-header");
        const n = await specHeaders.count();
        for (let i = 0; i < n; i++) await specHeaders.nth(i).click();
      }
      await expect(testButton.first()).toBeVisible({ timeout: 5_000 });
      await testButton.first().click();
      await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });

      // Left-pane Screenshots tab (the modal may default elsewhere).
      const screenshotTab = page.locator(".pane-left .pane-tab", { hasText: /^Screenshots/ });
      await expect(screenshotTab).toBeVisible({ timeout: 5_000 });
      await screenshotTab.click();

      const img = page.locator(".screenshot-main img");
      await expect(img).toBeVisible({ timeout: 5_000 });

      // The decisive assertion: the bytes loaded. A CSP block / 401 / 404
      // leaves naturalWidth === 0 while the element is still "visible".
      await expect
        .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
          timeout: 10_000,
          message: "screenshot <img> never decoded — naturalWidth stayed 0 (CSP img-src block, 401, or missing artifact)",
        })
        .toBeGreaterThan(0);
    } finally {
      await page.request.delete(`${API}/runs/${runId}`, { headers: auth(token) }).catch(() => {});
    }
  });
});
