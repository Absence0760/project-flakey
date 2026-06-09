import { expect, test, type Page } from "../fixtures/test";

/**
 * /releases/<id> — RULE-LEVEL FAILING ITEMS in the readiness panel.
 *
 * Both auto-rules return a `failing_items[]` list when unmet, and the
 * detail page renders each list inside a collapsible `<details class="rule">`:
 *
 *   - RULE_CRITICAL_TESTS_PASSING surfaces every failing automated test
 *     as an `<a class="failure-label" href="/runs/:id">` with the test
 *     title as text and its spec `file_path` as the `.dim.small` sublabel.
 *   - RULE_MANUAL_REGRESSION_EXECUTED surfaces every failing/blocked/
 *     not-run manual result as a `<button class="failure-label">` (no
 *     href — it scroll-flashes the session row) with the manual test's
 *     title as text and "<group> · <priority>" as the sublabel.
 *
 * The numbers and labels are server-computed (the rule logic in
 * backend/src/routes/releases.ts) and re-evaluated on every GET
 * /releases/:id via refreshAutoItems(). But NOTHING asserts those items
 * actually reach the DOM — a renderer regression (e.g. dropping the
 * `href`, swapping the failure list behind the wrong gate, or printing
 * the wrong sublabel) would ship silently behind a green readiness pill.
 *
 * This spec protects that surface. It is fully deterministic and
 * self-contained: it ingests its OWN failing automated run (so it knows
 * the failing test's exact title + spec-file path) and records its OWN
 * failing manual session result (so it knows that title), all in the
 * worker's own tenant via the documented REST endpoints — never relying
 * on incidental seed rows. Every wait is on a real signal (the readiness
 * pill rendering, the failing-item DOM node, a navigation), never a timer.
 *
 * Why API setup instead of UI: the run-picker only offers EXISTING runs
 * and can't control a run's failed-count, so a deterministic
 * "this exact test is the failing item" assertion requires ingesting the
 * run via /runs/upload and linking it via /releases/:id/runs. We then
 * assert in the real UI.
 *
 * If any assertion here fails, the FIX IS IN THE APP (the readiness
 * renderer or the rule that produces failing_items), not in this test.
 */

const API = "http://localhost:3000";

// Deterministic, unique-per-run identifiers so the assertions can match
// the failing item BY NAME and never collide with seed/worker data.
const STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const FAILING_AUTO_TITLE = `e2e auto fail ${STAMP}`;
const FAILING_SPEC_FILE = `e2e/readiness-${STAMP}.cy.ts`;
const FAILING_MANUAL_TITLE = `e2e manual fail ${STAMP}`;

async function getToken(page: Page): Promise<string> {
  // Caller must already be on an (app)/* route so restoreAuth() has run.
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
  return token;
}

function authJson(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Create a release with the DEFAULT_CHECKLIST (omit `items`) so both auto-rules exist. */
async function createRelease(page: Page, token: string): Promise<{ id: number; version: string }> {
  const version = `e2e-fi-${STAMP}`;
  const res = await page.request.post(`${API}/releases`, {
    headers: authJson(token),
    data: { version, name: "e2e readiness failing-items" },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  return { id: (await res.json()).id, version };
}

/**
 * Ingest a run with a single KNOWN failing test (plus some passes) so
 * evaluateCriticalTestsPassing() reports failed>0 and lists our test.
 * Multipart with the single `payload` JSON field, as the reporters send.
 */
async function uploadFailingRun(page: Page, token: string): Promise<number> {
  const ciRunId = `e2e-fi-${STAMP}`;
  const tests = [
    {
      title: "e2e auto pass", full_title: "e2e auto pass",
      status: "passed", duration_ms: 5, screenshot_paths: [],
    },
    {
      title: FAILING_AUTO_TITLE, full_title: FAILING_AUTO_TITLE,
      status: "failed", duration_ms: 5,
      error: { message: "boom", stack: null }, screenshot_paths: [],
    },
  ];
  const payload = {
    meta: {
      suite_name: `e2e-readiness-${ciRunId}`, branch: "main",
      commit_sha: `sha-${ciRunId}`, ci_run_id: ciRunId,
      started_at: "2026-06-08T00:00:00Z", finished_at: "2026-06-08T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [{
      file_path: FAILING_SPEC_FILE,
      title: "readiness fixture",
      stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 10 },
      tests,
    }],
  };
  const res = await page.request.post(`${API}/runs/upload`, {
    headers: { Authorization: `Bearer ${token}` }, // multipart sets Content-Type itself
    multipart: { payload: JSON.stringify(payload) },
  });
  if (!res.ok()) throw new Error(`/runs/upload: ${res.status()} ${await res.text()}`);
  return (await res.json() as { id: number }).id;
}

test.describe("/releases/<id> — readiness rule failing items", () => {
  let releaseId: number;
  let runId: number;
  let manualTestId: number;
  let groupId: number;
  let token: string;

  test.afterEach(async ({ page }) => {
    // Best-effort cleanup so re-runs don't accumulate worker-tenant rows.
    if (!token) return;
    if (releaseId) {
      await page.request
        .delete(`${API}/releases/${releaseId}`, { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
    if (runId) {
      await page.request
        .delete(`${API}/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
    if (manualTestId) {
      await page.request
        .delete(`${API}/manual-tests/${manualTestId}`, { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
    if (groupId) {
      await page.request
        .delete(`${API}/manual-test-groups/${groupId}`, { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
  });

  test("automated + manual failing items render by name, with /runs link and count matching the rule details", async ({ page }) => {
    // --- Setup (deterministic, via the documented REST endpoints) ---
    await page.goto("/dashboard");
    token = await getToken(page);

    const release = await createRelease(page, token);
    releaseId = release.id;

    // 1) Automated: ingest a run with one KNOWN failing test, link it.
    runId = await uploadFailingRun(page, token);
    const linkRun = await page.request.post(`${API}/releases/${releaseId}/runs`, {
      headers: authJson(token),
      data: { run_id: runId },
    });
    expect(linkRun.status(), "POST /releases/:id/runs should 2xx").toBeLessThan(400);

    // 2) Manual: create a group + test, link it, start a session, record
    //    a FAILED result. We link TWO tests so recording one failure does
    //    NOT auto-complete the session (a completed session would reject
    //    further writes); the still-not_run second test keeps it open and
    //    the rule reports the failure as a failing item.
    const grpRes = await page.request.post(`${API}/manual-test-groups`, {
      headers: authJson(token),
      data: { name: `e2e grp ${STAMP}` },
    });
    expect(grpRes.status(), "POST /manual-test-groups should 2xx").toBeLessThan(400);
    groupId = (await grpRes.json()).id;

    const mtRes = await page.request.post(`${API}/manual-tests`, {
      headers: authJson(token),
      data: { title: FAILING_MANUAL_TITLE, priority: "high", group_id: groupId },
    });
    expect(mtRes.status(), "POST /manual-tests should 2xx").toBeLessThan(400);
    manualTestId = (await mtRes.json()).id;

    // A second linked manual test (kept not_run) prevents auto-complete.
    const mt2Res = await page.request.post(`${API}/manual-tests`, {
      headers: authJson(token),
      data: { title: `e2e manual keepopen ${STAMP}`, priority: "high", group_id: groupId },
    });
    expect(mt2Res.status()).toBeLessThan(400);
    const keepOpenId = (await mt2Res.json()).id;

    const linkMt = await page.request.post(`${API}/releases/${releaseId}/manual-tests`, {
      headers: authJson(token),
      data: { manual_test_ids: [manualTestId, keepOpenId] },
    });
    expect(linkMt.status(), "POST /releases/:id/manual-tests should 2xx").toBeLessThan(400);

    const sessRes = await page.request.post(`${API}/releases/${releaseId}/sessions`, {
      headers: authJson(token),
      data: { mode: "full", label: "e2e regression" },
    });
    expect(sessRes.status(), "POST /releases/:id/sessions should 201").toBe(201);
    const sessionId = (await sessRes.json()).id;

    const failRes = await page.request.post(
      `${API}/releases/${releaseId}/sessions/${sessionId}/results/${manualTestId}`,
      { headers: authJson(token), data: { status: "failed", notes: "deterministic fail" } },
    );
    expect(failRes.status(), "record failed result should 2xx").toBeLessThan(400);
    // Sanity: recording one of two results must NOT have auto-completed.
    expect((await failRes.json()).session_completed, "session must stay in_progress").toBeFalsy();

    // --- Assert in the real UI ---
    await page.goto(`/releases/${releaseId}`);
    await expect(page.getByRole("heading", { name: release.version })).toBeVisible();

    const readiness = page.locator("section.readiness");
    // Readiness fetch landed when the verdict pill renders. Both rules are
    // unmet, so the page must be in the blocked state.
    await expect(readiness.locator(".blocked-pill")).toBeVisible();

    // ----- Automated rule: critical tests passing -----
    const autoRule = readiness.locator("details.rule", {
      // .rule-name renders the rule KEY with underscores→spaces ("critical
      // tests passing"), not the constant identifier.
      has: page.locator(".rule-name", { hasText: "critical tests passing" }),
    });
    await expect(autoRule).toHaveCount(1);
    // It is unmet → NOT met-styled → the failures live behind the expander.
    await expect(autoRule).not.toHaveClass(/\bmet\b/);

    // The details string encodes the failing-item count: "1 failing test(s)...".
    const autoDetail = await autoRule.locator(".rule-detail").innerText();
    const autoMatch = autoDetail.match(/(\d+)\s+failing test\(s\)/);
    expect(autoMatch, `auto rule detail should contain "N failing test(s)": "${autoDetail}"`).not.toBeNull();
    const autoFailingCount = Number(autoMatch![1]);
    expect(autoFailingCount).toBe(1);

    // Expand and assert the failing test renders BY NAME with a /runs link.
    await autoRule.locator("summary").click();
    const autoFailures = autoRule.locator("ul.rule-failures > li");
    await expect(autoFailures).toHaveCount(autoFailingCount);

    const autoFailRow = autoFailures.filter({ hasText: FAILING_AUTO_TITLE });
    await expect(autoFailRow).toHaveCount(1);
    const autoLink = autoFailRow.locator("a.failure-label");
    await expect(autoLink).toHaveText(FAILING_AUTO_TITLE);
    await expect(autoLink).toHaveAttribute("href", `/runs/${runId}`);
    // Sublabel is the spec file_path.
    await expect(autoFailRow.locator(".dim.small")).toHaveText(FAILING_SPEC_FILE);
    // Status pill present and correct.
    await expect(autoFailRow.locator(".status-pill.status-failed")).toBeVisible();

    // The href actually resolves to the run we linked.
    await autoLink.click();
    await page.waitForURL(`**/runs/${runId}`);
    await page.goBack();
    await expect(page.getByRole("heading", { name: release.version })).toBeVisible();

    // ----- Manual rule: manual regression executed -----
    const manualRule = readiness.locator("details.rule", {
      has: page.locator(".rule-name", { hasText: "manual regression executed" }),
    });
    await expect(manualRule).toHaveCount(1);
    await expect(manualRule).not.toHaveClass(/\bmet\b/);

    const manualDetail = await manualRule.locator(".rule-detail").innerText();
    const manualMatch = manualDetail.match(/(\d+)\s+failing test\(s\)/);
    expect(
      manualMatch,
      `manual rule detail should contain "N failing test(s)": "${manualDetail}"`,
    ).not.toBeNull();
    const manualFailingCount = Number(manualMatch![1]);
    expect(manualFailingCount).toBe(1);

    await manualRule.locator("summary").click();
    const manualFailures = manualRule.locator("ul.rule-failures > li");
    // The rule lists failing/blocked/not-run items; our recorded failure is
    // the only FAILED one and must appear by name as a (non-href) button.
    const manualFailRow = manualFailures.filter({ hasText: FAILING_MANUAL_TITLE });
    await expect(manualFailRow).toHaveCount(1);
    const manualBtn = manualFailRow.locator("button.failure-label");
    await expect(manualBtn).toHaveText(FAILING_MANUAL_TITLE);
    // Manual failing items are buttons (scroll-to-row), NOT links.
    await expect(manualFailRow.locator("a.failure-label")).toHaveCount(0);
    await expect(manualFailRow.locator(".status-pill.status-failed")).toBeVisible();
    // Sublabel is "<group> · <priority>".
    await expect(manualFailRow.locator(".dim.small")).toContainText("high");

    // Clicking the manual failure scroll-flashes its session row.
    await manualBtn.click();
    const sessionRow = page.locator(`tr#session-row-${manualTestId}`);
    await expect(sessionRow).toHaveClass(/row-flash/);
  });
});
