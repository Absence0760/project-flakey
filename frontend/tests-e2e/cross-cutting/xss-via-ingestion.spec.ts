import { expect, test, type Page } from "../fixtures/test";

/**
 * XSS through ingested test data.
 *
 * The dashboard renders strings that come straight off the wire from
 * /runs/upload (test names, full_titles, error messages, file paths)
 * across /runs/:id, /errors, /flaky, /releases. A reporter — or anyone
 * who can POST to /runs/upload with an API key — controls those values.
 * If any of them reach the DOM via {@html} or innerHTML without escaping,
 * a malicious test name like `<img src=x onerror=alert(1)>` runs script
 * in the dashboard's origin and can read the user's bt_token from
 * localStorage.
 *
 * Svelte's `{value}` template syntax auto-escapes, so this should hold
 * by construction — but {@html ...} is also legal Svelte and easy to
 * reach for. The whole point of these tests is to catch the moment
 * someone copy-pastes {@html} into a renderer of user-controlled text.
 *
 * Approach (per-route):
 *   1. Hook page.on('dialog') BEFORE navigation. An alert() / confirm()
 *      from injected script fires this handler — the assertion at the
 *      end fails if it ever did.
 *   2. Hook page.on('pageerror') for the parser-side leak (a partial
 *      injection that throws while parsing). A clean render produces
 *      neither dialog nor pageerror.
 *   3. Upload a run via /runs/upload with the XSS payloads embedded.
 *   4. Navigate to the route, wait for content, assert the literal
 *      payload string appears as text (proves the renderer saw it but
 *      didn't execute) and that no dialog/pageerror fired.
 *
 * Payloads are mainstream XSS smoke-test vectors. If any test fails
 * the FIX IS IN THE APP — the rendering surface that leaked is using
 * {@html} or innerHTML on attacker-controlled data and needs to switch
 * to plain interpolation (or to the existing escapeXml helper for SVG /
 * badge surfaces).
 */

const API = "http://localhost:3000";

// One vector per template-injection class. They share the same `<script>`
// prefix so a single textContent assertion proves the renderer rendered
// the literal — not a partial of it. Quotes inside the payload exercise
// attribute-context escaping (badge SVG fails the html-attribute-
// sanitization rule if it gets these wrong).
const XSS_PAYLOADS = {
  // Script tag — should be inert under any escape pass; HTML5 parser
  // only executes <script> nodes created via innerHTML if they're
  // inside a context that allows them (most don't, but {@html} does).
  scriptTag: '<script>window.__xssFired = true; alert("xss-script")</script>',
  // Image with onerror — the most reliable injection because it doesn't
  // depend on parser context. Fires on any innerHTML insertion.
  imgOnerror: '<img src=x onerror="window.__xssFired = true; alert(\'xss-img\')">',
  // SVG onload — bypasses naive `<script>`-only filters.
  svgOnload: '<svg onload="window.__xssFired = true; alert(\'xss-svg\')">',
  // Attribute breakout — relevant for any value rendered inside an
  // attribute context (title="...", aria-label="...").
  attributeBreakout: '"><img src=x onerror="window.__xssFired = true">',
};

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing from localStorage — sign-in fixture broken?");
  return token;
}

/**
 * Upload a run laced with XSS payloads in every user-controlled field
 * the renderer touches (test titles, full_titles, file_path, error
 * messages). Returns the new run id.
 */
async function uploadXssRun(page: Page, token: string, suite: string): Promise<number> {
  const ciRunId = `xss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: `sha-${ciRunId}`,
      ci_run_id: ciRunId,
      started_at: "2026-05-12T00:00:00Z",
      finished_at: "2026-05-12T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total: 4, passed: 0, failed: 4, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [{
      // file_path is rendered on /runs/:id under the spec heading.
      file_path: `${XSS_PAYLOADS.scriptTag}/spec.cy.ts`,
      title: XSS_PAYLOADS.imgOnerror,
      stats: { total: 4, passed: 0, failed: 4, skipped: 0, duration_ms: 10 },
      tests: [
        {
          // title is rendered on /runs/:id in the test row + /errors
          // group page in the fingerprint card. Both surfaces matter.
          title: XSS_PAYLOADS.scriptTag,
          full_title: XSS_PAYLOADS.scriptTag,
          status: "failed",
          duration_ms: 10,
          error: { message: XSS_PAYLOADS.imgOnerror, stack: XSS_PAYLOADS.svgOnload },
          screenshot_paths: [],
        },
        {
          title: XSS_PAYLOADS.imgOnerror,
          full_title: XSS_PAYLOADS.imgOnerror,
          status: "failed",
          duration_ms: 10,
          error: { message: XSS_PAYLOADS.scriptTag, stack: null },
          screenshot_paths: [],
        },
        {
          title: XSS_PAYLOADS.svgOnload,
          full_title: XSS_PAYLOADS.svgOnload,
          status: "failed",
          duration_ms: 10,
          error: { message: XSS_PAYLOADS.attributeBreakout, stack: null },
          screenshot_paths: [],
        },
        {
          title: XSS_PAYLOADS.attributeBreakout,
          full_title: XSS_PAYLOADS.attributeBreakout,
          status: "failed",
          duration_ms: 10,
          error: { message: XSS_PAYLOADS.scriptTag, stack: null },
          screenshot_paths: [],
        },
      ],
    }],
  };
  // Playwright's page.request.post takes a `multipart` object whose
  // keys become form fields; for a JSON-string field the value is just
  // the string. multer accepts this exactly as it does the cypress
  // reporter's wire format (single `payload` field with the JSON body).
  const res = await page.request.post(`${API}/runs/upload`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { payload: JSON.stringify(payload) },
  });
  if (!res.ok()) throw new Error(`/runs/upload: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request
    .delete(`${API}/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {});
}

/**
 * Attach the dialog + pageerror + window.__xssFired guards. Returns a
 * sentinel that the caller asserts on at the end.
 */
function installXssTraps(page: Page) {
  const fired: { dialog: string[]; pageError: string[] } = { dialog: [], pageError: [] };
  page.on("dialog", async (d) => {
    fired.dialog.push(`${d.type()}: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) => {
    fired.pageError.push(e.message);
  });
  return fired;
}

async function assertNoXssFired(page: Page, fired: ReturnType<typeof installXssTraps>) {
  // The injected payloads all set window.__xssFired = true on execution.
  // If the renderer escaped them properly, the global never gets set.
  const flag = await page.evaluate(() => (window as unknown as { __xssFired?: boolean }).__xssFired === true);
  expect(flag, "no XSS payload should have set window.__xssFired").toBe(false);
  expect(fired.dialog, "no alert/confirm/prompt should have fired").toEqual([]);
  expect(fired.pageError, "no page error should have fired from injected markup").toEqual([]);
}

test.describe("XSS through ingested test data", () => {

  let runId: number;
  let token: string;

  test.beforeAll(async ({ browser, workerAdminStorageState }) => {
    // Use a one-shot context to upload — beforeAll doesn't receive the
    // per-test `page` fixture, and we want runId to be reused across
    // the per-route assertions below to keep this spec fast.
    // workerAdminStorageState is worker-scoped so it's available here
    // and pins the upload to this worker's tenant (no Acme collision
    // when multiple Playwright workers run this spec in parallel).
    const ctx = await browser.newContext({ storageState: workerAdminStorageState });
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    token = await getToken(page);
    runId = await uploadXssRun(page, token, `xss-suite-${Date.now()}`);
    await ctx.close();
  });

  test.afterAll(async ({ browser, workerAdminStorageState }) => {
    if (!runId || !token) return;
    const ctx = await browser.newContext({ storageState: workerAdminStorageState });
    const page = await ctx.newPage();
    await deleteRun(page, token, runId);
    await ctx.close();
  });

  test("/runs/:id renders XSS-laden test titles + error messages as text, never as HTML", async ({ page }) => {
    const fired = installXssTraps(page);
    await page.goto(`/runs/${runId}`);
    // Don't wait for networkidle — the run-detail page opens an SSE
    // stream that keeps the network busy indefinitely. Wait for the
    // injected payload text to appear in the DOM instead; if the
    // renderer leaked it as HTML the script would fire BEFORE this
    // assertion completes anyway.
    await expect(page.locator("body")).toContainText("xss-script", { timeout: 10_000 });
    await assertNoXssFired(page, fired);
  });

  test("/errors renders the failure group's fingerprint payloads as text", async ({ page }) => {
    const fired = installXssTraps(page);
    await page.goto("/errors");
    // The errors page groups failures by fingerprint; the XSS-laden
    // test names from our run surface as group entries.
    await expect(page.locator("body")).toContainText("xss-script", { timeout: 10_000 });
    await assertNoXssFired(page, fired);
  });

  test("/flaky tolerates XSS-laden test names in its listing", async ({ page }) => {
    const fired = installXssTraps(page);
    await page.goto("/flaky");
    // /flaky may or may not have our run yet (it surfaces tests that have
    // flipped pass/fail across runs — a single run won't qualify), so we
    // can't wait on the payload text appearing. Wait on the page's
    // data-ready signal instead: it flips true once the listing fetch has
    // settled and the rows have rendered. Any payload that the render path
    // mishandled would have executed by then.
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 10_000 });
    await assertNoXssFired(page, fired);
  });
});
