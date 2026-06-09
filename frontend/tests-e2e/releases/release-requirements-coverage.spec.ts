import { expect, test, type Page } from "../fixtures/test";

/**
 * /releases/<id> — Requirements coverage reflects manual-session results.
 *
 * INVARIANT PROTECTED
 * -------------------
 * A "requirement" (e.g. a Jira ticket / GitHub issue key) is attached to one
 * or more manual tests via POST /manual-tests/:id/requirements. The release
 * detail page rolls those up into the Requirements-coverage panel
 * (GET /releases/:id/requirements), scoring each requirement by the EFFECTIVE
 * status of its linked manual tests — i.e. the MOST-RECENT release test
 * session's result for each test, falling back to the test's flat status when
 * no session exists (backend `latest_results` CTE,
 * backend/src/routes/releases.ts:1812-1846 — `COALESCE(lr.status, mt.status)`).
 *
 * The thing that's easy to silently break: the join from
 *   requirement -> manual_test -> session result -> coverage counts/badges.
 * If that wiring rots (wrong CTE, stale status, requirement counted against
 * the flat status instead of the session result), the UI keeps rendering but
 * shows a LIE — a requirement reads "fully passing" while the regression
 * session actually failed it, and a release ships on a green requirement that
 * is red in reality. This spec pins that wiring end-to-end through the real
 * backend and asserts the rendered DOM, not just the JSON.
 *
 * SETUP (all deterministic, via the documented API — no incidental seed rows):
 *   1. Create a fresh release (DEFAULT_CHECKLIST).
 *   2. Create TWO manual tests, both attaching the SAME requirement ref_key.
 *   3. Link both manual tests to the release.
 *   4. Start a session (mode=full → seeds one not_run row per linked test).
 *   5. Record one test `passed` and the other `failed`.
 *   6. Assert the single requirement row shows 1/2 passed · 1 failed, carries
 *      the `req-has-failures` class (NOT `req-fully-passing`), and renders the
 *      per-test status pills `status-passed` + `status-failed` — i.e. the
 *      session results flowed into coverage.
 *
 * A second case drives the all-pass path to prove the positive side: same
 * requirement on a single test, recorded `passed`, renders as
 * `req-fully-passing` with `1/1 passed`.
 *
 * Worker isolation: `test`/`expect` come from ../fixtures/test, so each
 * Playwright worker operates on its own seeded tenant (acme-w{parallelIndex}).
 * Cleanup deletes the release on teardown so re-runs don't accumulate rows.
 *
 * No masking: every wait is on a real DOM/network signal (the heading after
 * goto, the requirements panel expanding, the coverage text rendering). The
 * release detail page has no single `data-ready` handshake, so we gate on the
 * release heading + the requirements panel's own rendered content (which only
 * exists once GET /releases/:id/requirements resolves with ≥1 row).
 */

const API = "http://localhost:3000";

async function getToken(page: Page): Promise<string> {
  // Caller must already be on an (app)/* route so restoreAuth() has populated
  // localStorage before we read the token.
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
  return token;
}

function authJson(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createRelease(page: Page, token: string): Promise<number> {
  const version = `e2e-reqcov-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const res = await page.request.post(`${API}/releases`, {
    headers: authJson(token),
    // Omit `items` → backend injects DEFAULT_CHECKLIST (incl. the auto-rule items).
    data: { version, name: "e2e requirements coverage" },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  return (await res.json()).id;
}

async function createManualTest(page: Page, token: string, title: string): Promise<number> {
  const res = await page.request.post(`${API}/manual-tests`, {
    headers: authJson(token),
    data: { title, priority: "high" },
  });
  expect(res.status(), "POST /manual-tests should return 201").toBe(201);
  return (await res.json()).id;
}

async function attachRequirement(
  page: Page,
  token: string,
  manualTestId: number,
  refKey: string,
): Promise<void> {
  const res = await page.request.post(`${API}/manual-tests/${manualTestId}/requirements`, {
    headers: authJson(token),
    // No ref_url → provider infers to "other"; keeps the test free of any
    // external-host assumption (local-first).
    data: { ref_key: refKey, ref_title: "Regression requirement" },
  });
  expect(res.status(), "POST requirement should return 201").toBe(201);
}

async function linkManualTest(
  page: Page,
  token: string,
  releaseId: number,
  manualTestId: number,
): Promise<void> {
  const res = await page.request.post(`${API}/releases/${releaseId}/manual-tests`, {
    headers: authJson(token),
    data: { manual_test_id: manualTestId },
  });
  expect(res.status(), "POST link manual test should return 2xx").toBeLessThan(400);
  expect((await res.json()).linked, "exactly one manual test linked").toBe(1);
}

async function startSession(page: Page, token: string, releaseId: number): Promise<number> {
  const res = await page.request.post(`${API}/releases/${releaseId}/sessions`, {
    headers: authJson(token),
    data: { mode: "full", label: "e2e regression" },
  });
  expect(res.status(), "POST /sessions should return 201").toBe(201);
  return (await res.json()).id;
}

async function recordResult(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  testId: number,
  status: "passed" | "failed" | "blocked" | "skipped",
): Promise<void> {
  const res = await page.request.post(
    `${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}`,
    { headers: authJson(token), data: { status } },
  );
  expect(res.status(), `POST result ${status} should return 2xx`).toBeLessThan(400);
  expect((await res.json()).updated, "result recorded").toBe(true);
}

async function deleteRelease(page: Page, token: string, id: number): Promise<void> {
  await page.request
    .delete(`${API}/releases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {});
}

/**
 * Open the (closed-by-default) Requirements-coverage panel and return the
 * single `.req-table tbody tr` for the given ref_key. We scope by the
 * `.req-key` cell text so we don't collide with any other requirement rows
 * that an earlier release/test in the same tenant may have produced — though
 * each test uses a unique ref_key so the row is ours alone.
 */
function reqRow(page: Page, refKey: string) {
  return page
    .locator("section.requirements-panel table.req-table tbody tr")
    .filter({ has: page.locator(".req-key", { hasText: refKey }) });
}

async function openRequirementsPanel(page: Page): Promise<void> {
  const panel = page.locator("section.requirements-panel details");
  // The panel only renders once GET /releases/:id/requirements returns ≥1 row,
  // so its presence is itself the deterministic "coverage loaded" signal.
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
}

test.describe("/releases/<id> — requirements coverage ↔ session results", () => {
  test("a requirement on two tests reflects pass + fail from the session", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);

    const releaseId = await createRelease(page, token);
    // Unique per-run ref_key so this row is unambiguous within the tenant.
    const refKey = `REQ-PF-${Date.now().toString(36)}`.toUpperCase();

    try {
      const passTestId = await createManualTest(page, token, `req-cov pass ${Date.now()}`);
      const failTestId = await createManualTest(page, token, `req-cov fail ${Date.now()}`);

      // Same requirement attached to BOTH tests → one rollup row, total=2.
      await attachRequirement(page, token, passTestId, refKey);
      await attachRequirement(page, token, failTestId, refKey);

      await linkManualTest(page, token, releaseId, passTestId);
      await linkManualTest(page, token, releaseId, failTestId);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, passTestId, "passed");
      // Recording the second (final) result auto-completes the session; the
      // rollup reads the most-recent session's results either way.
      await recordResult(page, token, releaseId, sessionId, failTestId, "failed");

      await page.goto(`/releases/${releaseId}`);
      await expect(
        page.getByRole("heading", { name: /^e2e-reqcov-/ }),
      ).toBeVisible();

      await openRequirementsPanel(page);

      const row = reqRow(page, refKey);
      await expect(row).toHaveCount(1);

      // Coverage counts come straight from the session results: 1 passed of 2,
      // and the failure is surfaced.
      await expect(row).toContainText("1/2 passed");
      // The failure count renders in its own <span class="fail"> within the
      // coverage cell (+page.svelte:1236).
      await expect(row.locator("span.fail")).toContainText("1 failed");

      // The row is classed as having failures, NOT fully passing — this is the
      // gate that would let a release ship green on a red requirement if the
      // session-result wiring regressed.
      await expect(row).toHaveClass(/req-has-failures/);
      await expect(row).not.toHaveClass(/req-fully-passing/);

      // Per-test status pills inside the requirement row reflect the recorded
      // session results, not the flat manual_tests.status (which is still the
      // default for a brand-new manual test).
      await expect(row.locator(".req-test-row .status-pill.status-passed")).toHaveCount(1);
      await expect(row.locator(".req-test-row .status-pill.status-failed")).toHaveCount(1);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });

  test("a requirement on a single passing test reads as fully passing", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);

    const releaseId = await createRelease(page, token);
    const refKey = `REQ-OK-${Date.now().toString(36)}`.toUpperCase();

    try {
      const testId = await createManualTest(page, token, `req-cov solo ${Date.now()}`);
      await attachRequirement(page, token, testId, refKey);
      await linkManualTest(page, token, releaseId, testId);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, testId, "passed");

      await page.goto(`/releases/${releaseId}`);
      await expect(
        page.getByRole("heading", { name: /^e2e-reqcov-/ }),
      ).toBeVisible();

      await openRequirementsPanel(page);

      const row = reqRow(page, refKey);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("1/1 passed");
      await expect(row).toHaveClass(/req-fully-passing/);
      await expect(row).not.toHaveClass(/req-has-failures/);
      await expect(row.locator(".req-test-row .status-pill.status-passed")).toHaveCount(1);
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
