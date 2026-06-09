import { expect, test, type Page } from "../fixtures/test";

/**
 * /releases/<id> — known-issue acceptance feeds back into the readiness recompute.
 *
 * INVARIANT PROTECTED
 * -------------------
 * Accepting a failed manual-test result as a "known issue" must REMOVE it as a
 * release-readiness blocker. Acceptance is otherwise tested in isolation
 * (release-sessions.spec.ts records + accepts, but never re-reads readiness),
 * so nothing ties the accept action back to the gate that actually decides
 * whether a release can ship. This spec closes that loop.
 *
 * The readiness gate is driven by two AUTO-RULED checklist items computed
 * server-side and re-evaluated on every GET /releases/:id and
 * GET /releases/:id/readiness (refreshAutoItems / the rule evaluators in
 * backend/src/routes/releases.ts):
 *
 *   RULE_MANUAL_REGRESSION_EXECUTED — uses the MOST-RECENT session's results.
 *     A result whose status is failed/blocked is a blocker UNLESS it has been
 *     accepted_as_known_issue=TRUE, in which case it stops counting
 *     (releases.ts:192-195). The rule's `details` then carries a
 *     "(N accepted as known issue)" suffix, and the manual readiness card's
 *     `accepted` count goes up while `failed` no longer blocks.
 *
 * WHAT THIS SPEC DOES (all setup via the documented API for determinism — the
 * picker UI can't control which run/test/result it touches, so we never depend
 * on it for state):
 *
 *   1. Create a FRESH release (omit `items` → backend injects DEFAULT_CHECKLIST
 *      incl. both auto-rule readiness items) so we never mutate seed fixtures.
 *   2. Create + link TWO manual tests (one we'll pass, one we'll fail).
 *   3. Start a "full" session — seeds one not_run row per linked test. (A
 *      session requires ≥1 linked manual test, else 400 "No tests in scope".)
 *   4. Record the first as passed and the second as FAILED. Recording a
 *      terminal status for EVERY seeded row auto-completes the session
 *      (releases.ts:1417-1433) — so the session is already `completed`, which
 *      is exactly what lets the rule reach `met:true` once the failure clears
 *      (an in-progress session never goes green).
 *   5. Assert (via GET /readiness AND the rendered DOM) that the manual rule is
 *      UNMET, the failed test is listed as a failing item, and the verdict pill
 *      shows ≥1 blocker.
 *   6. ACCEPT the failed result as a known issue (POST .../accept). Acceptance
 *      checks the RESULT status, not the session status, so it succeeds on the
 *      already-completed session.
 *   7. Re-read readiness and assert the direction moved correctly: the manual
 *      blocker is GONE, the rule is now MET, its `details` carries
 *      "(1 accepted as known issue)", and the manual card reports
 *      `accepted >= 1` with no manual failure blocking.
 *
 * DETERMINISM / NO MASKING
 * ------------------------
 * Every wait is on a real signal: HTTP responses from the documented endpoints,
 * the JSON shape of GET /releases/:id/readiness, and concrete DOM the page only
 * renders once its three load() fetches resolve (the verdict pill, the rule
 * <details>, the manual readiness card). No waitForTimeout, no inflated expect
 * timeouts to absorb a race, no retry reliance, no loosened assertions. The
 * release detail page has no single `data-ready` handshake, so we gate cold
 * loads on the version heading + the readiness verdict pill (both of which only
 * appear after the readiness fetch lands) — sufficient and deterministic.
 */

const API = "http://localhost:3000";

async function getToken(page: Page): Promise<string> {
	// Caller must already be on an (app)/* route so restoreAuth() has populated
	// localStorage before we read the token.
	const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
	if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
	return token;
}

function authJson(token: string): { Authorization: string; "Content-Type": string } {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createRelease(page: Page, token: string): Promise<number> {
	const version = `e2e-ki-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
	const res = await page.request.post(`${API}/releases`, {
		headers: authJson(token),
		// Omit `items` → DEFAULT_CHECKLIST with both auto-rule readiness items.
		data: { version, name: "e2e known-issue readiness" },
	});
	expect(res.status(), "POST /releases should be 2xx").toBeLessThan(400);
	const body = await res.json();
	return body.id as number;
}

async function createManualTest(page: Page, token: string, title: string): Promise<number> {
	const res = await page.request.post(`${API}/manual-tests`, {
		headers: authJson(token),
		data: { title, priority: "high" },
	});
	expect(res.status(), "POST /manual-tests should be 2xx").toBeLessThan(400);
	return (await res.json()).id as number;
}

async function linkManualTest(page: Page, token: string, releaseId: number, manualTestId: number): Promise<void> {
	const res = await page.request.post(`${API}/releases/${releaseId}/manual-tests`, {
		headers: authJson(token),
		data: { manual_test_id: manualTestId },
	});
	expect(res.status(), "POST /releases/:id/manual-tests should be 2xx").toBeLessThan(400);
}

async function startSession(page: Page, token: string, releaseId: number): Promise<number> {
	const res = await page.request.post(`${API}/releases/${releaseId}/sessions`, {
		headers: authJson(token),
		data: { mode: "full", label: "e2e regression" },
	});
	expect(res.status(), "POST /releases/:id/sessions should be 201").toBe(201);
	return (await res.json()).id as number;
}

async function recordResult(
	page: Page,
	token: string,
	releaseId: number,
	sessionId: number,
	testId: number,
	status: "passed" | "failed" | "blocked" | "skipped",
): Promise<{ session_completed: boolean }> {
	const res = await page.request.post(
		`${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}`,
		{ headers: authJson(token), data: { status } },
	);
	expect(res.status(), `record ${status} should be 2xx`).toBeLessThan(400);
	return await res.json();
}

async function acceptResult(
	page: Page,
	token: string,
	releaseId: number,
	sessionId: number,
	testId: number,
	knownIssueRef: string,
): Promise<void> {
	const res = await page.request.post(
		`${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}/accept`,
		{ headers: authJson(token), data: { known_issue_ref: knownIssueRef } },
	);
	expect(res.status(), "POST .../accept should be 2xx").toBeLessThan(400);
}

interface Readiness {
	manual_tests: { linked: number; passed: number; failed: number; blocked: number; not_run: number; accepted: number };
	rules: { manual_regression_executed: { met: boolean; details: string; failing_items?: Array<{ label: string; test_id?: number }> } };
	blocking_items: Array<{ id: number; label: string; auto_rule: string | null; auto_details: string | null }>;
	ready: boolean;
}

async function getReadiness(page: Page, token: string, releaseId: number): Promise<Readiness> {
	const res = await page.request.get(`${API}/releases/${releaseId}/readiness`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.status(), "GET /releases/:id/readiness should be 2xx").toBeLessThan(400);
	return (await res.json()) as Readiness;
}

async function deleteRelease(page: Page, token: string, releaseId: number): Promise<void> {
	await page.request
		.delete(`${API}/releases/${releaseId}`, { headers: { Authorization: `Bearer ${token}` } })
		.catch(() => {});
}

test.describe("/releases/<id> — known-issue acceptance clears the readiness blocker", () => {
	test("accepting a failed manual result removes its blocker and flips the manual rule to met", async ({ page }) => {
		// Land authenticated in the worker's tenant so restoreAuth() runs, then
		// grab the bearer token for the API-driven setup.
		await page.goto("/dashboard");
		const token = await getToken(page);

		// --- Deterministic, self-contained setup (worker tenant, via API) ---
		const releaseId = await createRelease(page, token);
		try {
			const passTestId = await createManualTest(page, token, `ki-pass ${Date.now()}`);
			const failTestId = await createManualTest(page, token, `ki-fail ${Date.now()}`);
			await linkManualTest(page, token, releaseId, passTestId);
			await linkManualTest(page, token, releaseId, failTestId);

			const sessionId = await startSession(page, token, releaseId);

			// Record both rows. The SECOND terminal status leaves zero not_run
			// rows, so the session auto-completes — required for the manual rule
			// to be eligible to go green later (an in-progress session never does).
			await recordResult(page, token, releaseId, sessionId, passTestId, "passed");
			const lastRecord = await recordResult(page, token, releaseId, sessionId, failTestId, "failed");
			expect(
				lastRecord.session_completed,
				"recording the final row should auto-complete the session",
			).toBe(true);

			// === Phase 1: the failed result blocks readiness ===
			const before = await getReadiness(page, token, releaseId);
			expect(before.manual_tests.linked).toBe(2);
			expect(before.manual_tests.failed, "one manual failure before accept").toBe(1);
			expect(before.manual_tests.accepted, "nothing accepted yet").toBe(0);
			expect(before.rules.manual_regression_executed.met, "manual rule unmet while a failure stands").toBe(false);

			// The failed test must be listed as a failing item on the manual rule,
			// keyed by its manual_test_id.
			const failingBefore = before.rules.manual_regression_executed.failing_items ?? [];
			expect(failingBefore.some((it) => it.test_id === failTestId), "failed test appears as a failing item").toBe(true);

			// And it must register as a blocker on the gate (the manual auto-rule item).
			const manualBlocker = before.blocking_items.find(
				// auto_rule stores the rule constant's VALUE, not its identifier name.
				(b) => b.auto_rule === "manual_regression_executed",
			);
			expect(manualBlocker, "manual regression rule is a blocking item before accept").toBeTruthy();

			// Assert the same blocked state in the rendered DOM. Cold-load gate:
			// the version heading + the verdict pill only render after load()'s
			// readiness fetch resolves — no timer needed.
			await page.goto(`/releases/${releaseId}`);
			const readinessSection = page.locator("section.readiness");
			await expect(readinessSection.locator(".blocked-pill")).toBeVisible();
			await expect(readinessSection.locator(".ready-pill")).toHaveCount(0);

			// The manual rule renders as a collapsible <details class="rule"> (it has
			// failing_items). Scope by its rule-name, assert it's UNMET (no .met),
			// then expand to reveal the failing item behind the <summary>.
			const manualRule = readinessSection
				.locator("details.rule")
				.filter({ has: page.locator(".rule-name", { hasText: "MANUAL REGRESSION EXECUTED" }) });
			await expect(manualRule).toHaveCount(1);
			await expect(manualRule).not.toHaveClass(/\bmet\b/);
			await manualRule.locator("summary").click();
			const failingButton = manualRule.locator("ul.rule-failures button.failure-label");
			await expect(failingButton).toHaveCount(1);

			// Manual readiness card (card index 1) reflects the failure, no accepts yet.
			const manualCard = readinessSection
				.locator(".readiness-card")
				.filter({ has: page.locator(".card-title", { hasText: "Manual tests" }) });
			await expect(manualCard.locator(".card-big")).toHaveText("1/2 passed");
			await expect(manualCard.locator(".card-sub")).toContainText("1 failed");
			await expect(manualCard.locator(".card-sub")).not.toContainText("accepted");

			// === Phase 2: accept the failure as a known issue ===
			await acceptResult(page, token, releaseId, sessionId, failTestId, "ACME-482");

			// === Phase 3: the blocker is gone and the rule is now met ===
			const after = await getReadiness(page, token, releaseId);
			expect(after.manual_tests.accepted, "one result now accepted").toBe(1);
			expect(
				after.blocking_items.some((b) => b.auto_rule === "manual_regression_executed"),
				"manual regression rule no longer blocks after accept",
			).toBe(false);
			expect(
				after.rules.manual_regression_executed.met,
				"manual rule met — completed session, only failure is accepted",
			).toBe(true);
			expect(
				after.rules.manual_regression_executed.details,
				"details note the accepted known issue",
			).toContain("accepted as known issue");
			expect(after.rules.manual_regression_executed.details).toContain("1 accepted as known issue");

			// Verdict moved in the right direction: strictly fewer blockers than before.
			expect(after.blocking_items.length).toBeLessThan(before.blocking_items.length);

			// Re-assert in the DOM after the accept mutation. Re-goto for a cold
			// fetch; the manual rule, now without failing_items, renders as a static
			// div.rule with the .met class.
			await page.goto(`/releases/${releaseId}`);
			const readinessAfter = page.locator("section.readiness");
			const manualRuleAfter = readinessAfter
				.locator(".rule")
				.filter({ has: page.locator(".rule-name", { hasText: "MANUAL REGRESSION EXECUTED" }) });
			await expect(manualRuleAfter).toHaveClass(/\bmet\b/);
			await expect(manualRuleAfter.locator(".rule-detail")).toContainText("accepted as known issue");

			// Manual card now reports the accepted count.
			const manualCardAfter = readinessAfter
				.locator(".readiness-card")
				.filter({ has: page.locator(".card-title", { hasText: "Manual tests" }) });
			await expect(manualCardAfter.locator(".card-sub")).toContainText("1 accepted");

			// The accepted failure surfaces in the "known issues deferred" details.
			const acceptedPanel = readinessAfter.locator("details.readiness-accepted");
			await expect(acceptedPanel.locator(".accepted-count")).toHaveText("1");
		} finally {
			await deleteRelease(page, token, releaseId);
		}
	});
});
