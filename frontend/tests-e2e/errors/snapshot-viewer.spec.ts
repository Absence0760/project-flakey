import { expect, test } from "../fixtures/test";


/**
 * ErrorModal — snapshot click-through, action-level + step-level.
 *
 * The seed inserts a deterministic Cucumber-style run (suite_name
 * "e2e-cucumber", commit "gherkin01") with a single failed test
 * carrying both a Gherkin-grouped command_log and a matching
 * snapshot bundle whose Given/When/Then entries surface as
 * commandName === "gherkin" steps. That run is what unlocks
 * ErrorModal's gherkin-grouped command list (`hasCommandGherkinGroups`
 * branch) — flat command logs in the rest of the seed can't.
 *
 * The contract being asserted:
 *   - Click a step-level entry (cmd-gherkin / cmd-setup) → that <li>
 *     gets `cmd-locked`; the snapshot frame switches to that step.
 *   - Click an action-level entry (cmd-child) → its <li> gets
 *     `cmd-locked`, the parent loses it.
 *   - Hovering a different entry → that <li> gets `cmd-active`
 *     (hover layer) while the previously-locked entry keeps
 *     `cmd-locked` (click-priority is on top of hover).
 *   - mouseleave on the list clears hover → cmd-active reverts to
 *     whatever was clicked last.
 *   - Clicking an already-locked child toggles it off (lockedStep
 *     drops back to null) per ErrorModal.svelte:647.
 */

async function openGherkinRun(page: import("@playwright/test").Page): Promise<number> {
  // First land on /dashboard so localStorage has the auth token (the
  // root layout's onMount restores it). Then ask the backend for the
  // gherkin demo run by suite_name — that's a stable identifier across
  // re-seeds, while the run id is not.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

  const runId = await page.evaluate(async () => {
    const token = localStorage.getItem("bt_token");
    const res = await fetch("http://localhost:3000/runs?limit=200", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const run = body.runs.find((r: { suite_name: string }) => r.suite_name === "e2e-cucumber");
    return run?.id ?? null;
  });
  expect(runId, "seed should have created the e2e-cucumber gherkin demo run").toBeTruthy();

  await page.goto(`/runs/${runId}`);
  // The polished detail header lands the run id as a meta-row chip,
  // not an <h1>. Wait on that chip as evidence of load.
  await expect(
    page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
  ).toBeVisible({ timeout: 10_000 });
  return runId as number;
}

async function openErrorModal(page: import("@playwright/test").Page): Promise<void> {
  // The single failed test renders as a clickable .test-name button
  // inside the spec list. The polished detail page also surfaces the
  // same test inside the at-risk-band as <li role="button"> when it's
  // a regression vs the prev run — scope the locator to the spec
  // list so we don't match both. ErrorModal opens via
  // `modalTestId = test.id` in the runs/[id] route.
  const testButton = page.locator(".test-list").getByRole("button", {
    name: "Login with valid credentials (Gherkin demo)",
  });
  await expect(testButton).toBeVisible({ timeout: 5_000 });
  await testButton.click();

  // Modal lands. The .debugger element only renders when testId is set
  // and the test fetch resolved.
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });

  // hasSnapshot is true → leftTab defaults to "snapshot" (ErrorModal:205).
  // The Snapshot pane-tab should read .active.
  const snapshotTab = page.locator(".pane-tab", { hasText: /^Snapshot$/ });
  await expect(snapshotTab).toHaveClass(/active/);

  // Right pane: open the Commands tab so the command-list mounts.
  await page.locator(".pane-tab", { hasText: /^Commands/ }).click();
  await expect(page.locator(".command-list")).toBeVisible({ timeout: 5_000 });
}

test.describe("ErrorModal snapshot viewer (gherkin demo run)", () => {

  test("renders gherkin parents AND child commands in the command list", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    // The seed's command log groups into:
    //   - 1 cmd-setup (synthetic header for `visit /login`) + 1 child
    //   - 1 cmd-gherkin GIVEN + 2 children (get, type)
    //   - 1 cmd-gherkin WHEN  + 3 children (get, type, click)
    //   - 1 cmd-gherkin THEN  + 1 child (should)
    // Total: 3 cmd-gherkin, 1 cmd-setup, 7 cmd-child.
    const list = page.locator(".command-list");
    await expect(list.locator("li.cmd-gherkin")).toHaveCount(3);
    await expect(list.locator("li.cmd-setup")).toHaveCount(1);

    // All three keywords are present and labeled.
    await expect(list.locator("li.cmd-gherkin").nth(0)).toContainText("GIVEN");
    await expect(list.locator("li.cmd-gherkin").nth(1)).toContainText("WHEN");
    await expect(list.locator("li.cmd-gherkin").nth(2)).toContainText("THEN");

    // Children render under each parent because groups default open.
    await expect(list.locator("li.cmd-child")).toHaveCount(7);
  });

  test("Collapse all / Expand all toggles every step group at once", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    const toggle = page.locator(".collapse-toggle");

    // Groups default open: all 7 children are present and the toggle
    // offers to collapse them.
    await expect(list.locator("li.cmd-child")).toHaveCount(7);
    await expect(toggle).toHaveText("Collapse all");

    // Collapse all → every group's children fold away and the toggle
    // flips to the inverse action.
    await toggle.click();
    await expect(list.locator("li.cmd-child")).toHaveCount(0);
    await expect(toggle).toHaveText("Expand all");

    // Expand all → all children come back.
    await toggle.click();
    await expect(list.locator("li.cmd-child")).toHaveCount(7);
    await expect(toggle).toHaveText("Collapse all");
  });

  test("snapshot tab + iframe render with snapshot data", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    // The SnapshotViewer renders an <iframe title="DOM Snapshot">. If
    // the bundle fetch failed or the gzip parse threw, the viewer
    // falls back to an empty state and no iframe lands.
    await expect(page.locator('iframe[title="DOM Snapshot"]')).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a step-level (cmd-gherkin) parent locks that step", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    const givenItem = list.locator("li.cmd-gherkin").nth(0);
    const whenItem = list.locator("li.cmd-gherkin").nth(1);

    // Click the WHEN step. cmd-locked should land on it; the GIVEN
    // step should not be locked (only one step is the lockedStep at
    // a time).
    await whenItem.click();
    await expect(whenItem).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(givenItem).not.toHaveClass(/\bcmd-locked\b/);

    // Click GIVEN; lock moves.
    await givenItem.click();
    await expect(givenItem).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(whenItem).not.toHaveClass(/\bcmd-locked\b/);
  });

  test("clicking an action-level (cmd-child) command locks AND moves the snapshot", async ({
    page,
  }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    // SnapshotViewer's footer renders `<step-count>X / Y</step-count>`
    // and `<step-name>commandName — commandMessage</step-name>`. Both
    // are bound to the active snapshot step — if the snapshot didn't
    // actually re-render in response to a click, these stay frozen
    // even though the modal's class state changes.
    const stepCount = page.locator(".snapshot-viewer .step-count");
    const stepName = page.locator(".snapshot-viewer .step-name");

    // Cold open: hasSnapshot defaults snapshotStep to 0 → "1 / 10".
    // The first snapshot step is the cypress `visit /login`.
    await expect(stepCount).toHaveText("1 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("visit");

    // All four groups (Setup/Given/When/Then) start expanded, so all
    // 7 cmd-child rows are in the DOM in order:
    //   nth(0) Setup → visit       (snap 0)
    //   nth(1) Given → get email   (snap 2)
    //   nth(2) Given → type user   (snap 3)
    //   nth(3) When  → get pwd     (snap 5)
    //   nth(4) When  → type pwd    (snap 6)
    //   nth(5) When  → click       (snap 7)
    //   nth(6) Then  → should      (snap 9)
    const list = page.locator(".command-list");

    // Click the first WHEN action — `get [data-testid="password-input"]`.
    // Snapshot must advance to step 5 → footer "6 / 10", and the step
    // name must reflect the cypress command, not the gherkin header.
    const whenFirstChild = list.locator("li.cmd-child").nth(3);
    await whenFirstChild.click();
    await expect(whenFirstChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(stepCount).toHaveText("6 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("get");
    await expect(stepName).toContainText("password-input");
    await expect(stepName).not.toContainText("When the user submits");

    // Click WHEN's second action (`type SecurePass123`). Snapshot
    // advances one more step. If clicking children only changed the
    // class (lockedStep) but not snapshotStep, this assertion fails.
    const whenSecondChild = list.locator("li.cmd-child").nth(4);
    await whenSecondChild.click();
    await expect(whenSecondChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(stepCount).toHaveText("7 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("type");
    await expect(stepName).toContainText("SecurePass123");

    // Click the failing THEN action (`should include /dashboard`) —
    // snapshot lands on the last step (the failure frame).
    const thenChild = list.locator("li.cmd-child").nth(6);
    await thenChild.click();
    await expect(thenChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(stepCount).toHaveText("10 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("should");
  });

  test("hovering an action-level command moves the snapshot without losing the lock", async ({
    page,
  }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const stepCount = page.locator(".snapshot-viewer .step-count");
    const stepName = page.locator(".snapshot-viewer .step-name");
    const list = page.locator(".command-list");

    // Lock GIVEN's first action (`get email-input`) → snapshot "3 / 10".
    // Avoid clicking the gherkin parent itself: that would toggle the
    // group closed and hide its children.
    const givenFirstChild = list.locator("li.cmd-child").nth(1);
    await givenFirstChild.click();
    await expect(givenFirstChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(stepCount).toHaveText("3 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("get");
    await expect(stepName).toContainText("email-input");

    // Hover the THEN action (`should include /dashboard`). The
    // snapshot must temporarily switch to step "10 / 10" while the
    // lock remains on the GIVEN child. If hover-on-children was
    // wired to the parent gherkin step (or didn't fire at all), the
    // step counter would stay at "3 / 10".
    const thenChild = list.locator("li.cmd-child").nth(6);
    await thenChild.hover();
    await expect(thenChild).toHaveClass(/\bcmd-active\b/, { timeout: 2_000 });
    await expect(stepCount).toHaveText("10 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("should");

    // Lock didn't move: GIVEN's first child still has cmd-locked.
    await expect(givenFirstChild).toHaveClass(/\bcmd-locked\b/);

    // Move the mouse off the command list. onmouseleave clears
    // hoverStep → activeSnapshotStep falls back to lockedStep →
    // snapshot reverts to the locked step ("3 / 10"). If the click
    // had locked the lockedStep but the hover-state had broken, the
    // snapshot would stick at "10 / 10" here.
    await page.locator(".debugger .topbar").hover({ position: { x: 5, y: 5 } });
    await expect(stepCount).toHaveText("3 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("get");
    await expect(stepName).toContainText("email-input");
  });

  test("clicking a step-level (cmd-gherkin) parent moves the snapshot to the gherkin frame", async ({
    page,
  }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const stepCount = page.locator(".snapshot-viewer .step-count");
    const stepName = page.locator(".snapshot-viewer .step-name");
    const list = page.locator(".command-list");

    // GIVEN parent → snapshot index 1 (the gherkin marker for
    // "Given the user is on the login page") → "2 / 10". This also
    // collapses the GIVEN group as a side-effect; what we care about
    // here is the snapshot moved.
    await list.locator("li.cmd-gherkin").nth(0).click();
    await expect(stepCount).toHaveText("2 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("gherkin");
    await expect(stepName).toContainText("Given the user is on the login page");

    // THEN parent → snapshot index 8 → "9 / 10".
    await list.locator("li.cmd-gherkin").nth(2).click();
    await expect(stepCount).toHaveText("9 / 10", { timeout: 2_000 });
    await expect(stepName).toContainText("Then the dashboard should load");
  });

  test("hovering a different command sets cmd-active without clearing the locked step", async ({
    page,
  }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    const givenParent = list.locator("li.cmd-gherkin").nth(0);
    const thenParent = list.locator("li.cmd-gherkin").nth(2);

    // Lock GIVEN.
    await givenParent.click();
    await expect(givenParent).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(givenParent).toHaveClass(/\bcmd-active\b/);

    // Hover THEN — onmouseenter sets hoverStep, which feeds
    // activeSnapshotStep ?? lockedStep. THEN should pick up cmd-active;
    // GIVEN keeps cmd-locked but loses cmd-active (only one step is
    // active at a time).
    await thenParent.hover();
    await expect(thenParent).toHaveClass(/\bcmd-active\b/, { timeout: 2_000 });
    await expect(givenParent).toHaveClass(/\bcmd-locked\b/);
    await expect(givenParent).not.toHaveClass(/\bcmd-active\b/);

    // Move the mouse off the command list entirely. onmouseleave on
    // .command-list clears hoverStep → activeSnapshotStep falls back
    // to lockedStep → GIVEN regains cmd-active and THEN loses it.
    await page.locator(".debugger").hover({ position: { x: 5, y: 5 } });
    await expect(givenParent).toHaveClass(/\bcmd-active\b/, { timeout: 2_000 });
    await expect(thenParent).not.toHaveClass(/\bcmd-active\b/);
  });

  test("clicking an already-locked child unlocks it (toggle-off)", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    // Lock GIVEN's first child (cmd-child index 0).
    const givenFirstChild = list.locator("li.cmd-child").nth(0);
    await givenFirstChild.click();
    await expect(givenFirstChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });

    // Click again; lockedStep = lockedStep === childBestIdx ? null : childBestIdx
    // (ErrorModal.svelte:647). Re-clicking the same child unlocks it.
    await givenFirstChild.click();
    await expect(givenFirstChild).not.toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
  });

  test("snapshot iframe content updates when stepping through commands", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    // The SnapshotViewer writes the active step's html into the
    // iframe srcdoc. Different steps have different srcdoc text — we
    // assert the srcdoc CHANGES across two locked steps without
    // pinning specific text (gives the seeded HTML some room to
    // evolve without breaking this contract test).
    const iframe = page.locator('iframe[title="DOM Snapshot"]');
    await expect(iframe).toBeVisible();

    const list = page.locator(".command-list");

    // Lock GIVEN (snapshot step 1).
    await list.locator("li.cmd-gherkin").nth(0).click();
    await expect(list.locator("li.cmd-gherkin").nth(0)).toHaveClass(/\bcmd-locked\b/, {
      timeout: 2_000,
    });
    const givenSrc = await iframe.getAttribute("srcdoc");
    expect(givenSrc, "iframe should have srcdoc populated for the GIVEN step").toBeTruthy();

    // Lock THEN (snapshot step 8).
    await list.locator("li.cmd-gherkin").nth(2).click();
    await expect(list.locator("li.cmd-gherkin").nth(2)).toHaveClass(/\bcmd-locked\b/, {
      timeout: 2_000,
    });
    // Re-fetch srcdoc; it must differ.
    await expect
      .poll(
        async () => await iframe.getAttribute("srcdoc"),
        { timeout: 3_000, message: "srcdoc should change when locking a different step" },
      )
      .not.toBe(givenSrc);
  });

  /* Issue #26 regression — snapshot zoom + no-snap feedback. */

  test("snapshot zoom controls scale the iframe in both directions and clamp", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const scaler = page.locator(".snapshot-scaler");
    await expect(scaler).toBeVisible();

    const zoomIn = page.getByRole("button", { name: /^Zoom in$/ });
    const zoomOut = page.getByRole("button", { name: /^Zoom out$/ });
    const reset = page.getByRole("button", { name: /^Reset zoom$/ });
    await expect(zoomIn).toBeVisible();

    // Snapshot the scaler's rendered width at default zoom, then zoom in
    // twice and confirm the scaler grows. Width is `viewportWidth *
    // fitScale * zoom`, so zoom 1 → 1.5625× (1.25^2) is detectable at
    // any pane size that doesn't already pin scale to 1.
    const initial = (await scaler.boundingBox())!.width;

    await zoomIn.click();
    await zoomIn.click();
    await expect.poll(async () => (await scaler.boundingBox())!.width).toBeGreaterThan(initial);

    // Reset returns us to the fit-scale baseline.
    await reset.click();
    await expect
      .poll(async () => (await scaler.boundingBox())!.width)
      .toBeCloseTo(initial, 0);

    // Zooming out below 0.5 must be impossible — the button clamps via
    // :disabled. Default zoom is 1; each click divides by 1.25, so the
    // 4th click crosses the 0.5 floor (1 → 0.8 → 0.64 → 0.512 → 0.5)
    // and the button latches disabled on the next render.
    await reset.click();
    for (let i = 0; i < 4; i++) {
      if (await zoomOut.isDisabled()) break;
      await zoomOut.click();
    }
    await expect(zoomOut).toBeDisabled();
  });

  test("zoom-reset button shows the percentage in its label", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    // The reset button doubles as a percentage readout: "<NN>%".
    const reset = page.getByRole("button", { name: /^Reset zoom$/ });
    await expect(reset).toHaveText(/^\d+%$/);

    const initialLabel = await reset.textContent();
    const zoomIn = page.getByRole("button", { name: /^Zoom in$/ });
    await zoomIn.click();
    await expect(reset).not.toHaveText(initialLabel ?? "");
    await expect(reset).toHaveText(/^\d+%$/);
  });
});

test.describe("ErrorModal per-step diagnostics (Phase 2)", () => {
  // The seed attaches per-step console/network to the gherkin demo bundle:
  //   - the "submit" click step → POST /api/login 200 + GET /api/dashboard 401
  //   - the failing "should" step → a console error + GET /api/session 401
  // Flattened cmd-child order: visit(0) get(1) type(2) get(3) type(4)
  //   click(5) should(6).

  test("step rows with console errors / failed requests show a red badge", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    // Exactly two steps carry errors (the click's 401 and the failing should);
    // the other child rows have no console/network and so no badge.
    await expect(list.locator("li.cmd-child .cmd-diag-badge.has-error")).toHaveCount(2);

    const clickRow = list.locator("li.cmd-child").nth(5);
    await expect(clickRow).toContainText("submit");
    await expect(clickRow.locator(".cmd-diag-badge.has-error")).toBeVisible();
  });

  test("selecting a step reveals its console + network in the viewer strip", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");

    // The first step (visit) has no console/network → no strip rendered.
    await expect(page.locator(".step-diag")).toHaveCount(0);

    // Select the "submit" click step → its network surfaces.
    await list.locator("li.cmd-child").nth(5).click();

    const strip = page.locator(".step-diag");
    await expect(strip).toBeVisible();
    await expect(strip.locator(".diag-pill").filter({ hasText: /Network/ })).toBeVisible();
    await expect(strip.locator(".diag-pill-error")).toBeVisible(); // the GET /api/dashboard 401

    // Expand and verify the request rows; the 401 is flagged as a failure.
    await strip.locator(".diag-header").click();
    await expect(strip.locator(".diag-network li").filter({ hasText: "/api/login" })).toBeVisible();
    const failRow = strip.locator(".diag-network li.net-fail");
    await expect(failRow).toContainText("/api/dashboard");
    await expect(failRow).toContainText("401");
  });

  test("the failing step's strip shows the captured console error", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    // The failing "should" step (last child) carries a console error.
    await list.locator("li.cmd-child").nth(6).click();

    const strip = page.locator(".step-diag");
    await expect(strip).toBeVisible();
    await strip.locator(".diag-header").click();
    await expect(strip.locator(".diag-console li.console-err")).toBeVisible();
    await expect(strip.locator(".diag-console")).toContainText("expected /dashboard");
  });
});
