import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

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
  await expect(page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) })).toBeVisible({
    timeout: 10_000,
  });
  return runId as number;
}

async function openErrorModal(page: import("@playwright/test").Page): Promise<void> {
  // The single failed test renders as a clickable .test-name button.
  // ErrorModal opens via `modalTestId = test.id` in the runs/[id] route.
  const testButton = page.getByRole("button", {
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
  test.use({ storageState: ADMIN_USER.storageStatePath });

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

  test("clicking an action-level (cmd-child) command locks that child", async ({ page }) => {
    await openGherkinRun(page);
    await openErrorModal(page);

    const list = page.locator(".command-list");
    const whenParent = list.locator("li.cmd-gherkin").nth(1);

    // Lock the parent first.
    await whenParent.click();
    await expect(whenParent).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });

    // Now click an action under WHEN. Children are emitted in DOM
    // order: Setup has 1 (idx 0), Given has 2 (idx 1,2), When has 3
    // (idx 3,4,5), Then has 1 (idx 6). WHEN's first child is index 3.
    const whenFirstChild = list.locator("li.cmd-child").nth(3);
    await whenFirstChild.click();

    // Lock moves to the child; parent loses it.
    await expect(whenFirstChild).toHaveClass(/\bcmd-locked\b/, { timeout: 2_000 });
    await expect(whenParent).not.toHaveClass(/\bcmd-locked\b/);
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
});
