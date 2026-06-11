import { expect, type Page } from "../fixtures/test";

/**
 * Shared ErrorModal e2e helpers.
 *
 * Locate a run id + test id for a seeded test matching `titleFragment`
 * AND the data shape the caller needs, then open the modal for it.
 *
 * The naive "first title match" approach is brittle because the dev DB
 * accumulates synthetic runs from other specs (live-run, live-reporter-
 * adapters, etc.). When a synthetic run shares a title fragment with a
 * seeded test, the synthetic match wins and the test fails because the
 * synthetic record lacks test_code / metadata / command_log / screenshots.
 *
 * Filtering on the data shape returns the right run regardless of how
 * many synthetic runs exist or what they're titled.
 */
export async function findRunAndTest(
  page: Page,
  match: {
    titleFragment: string;
    needsCode?: boolean;
    needsMetadata?: boolean;
    needsCommandLog?: boolean;
  },
): Promise<{ runId: number; testId: number }> {
  await page.goto("/dashboard");
  const result = await page.evaluate(async (criteria) => {
    const token = localStorage.getItem("bt_token");
    // limit=500 — earlier specs in the suite create dozens of fresh
    // /live/start + /runs/upload rows that all sort above the seed
    // Playwright runs (created_at scattered 1-14 days ago). 200 was
    // not enough to reach them once the suite warmed up.
    const runsRes = await fetch("http://localhost:3000/runs?limit=500", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const runsBody = await runsRes.json();
    for (const r of runsBody.runs as Array<{ id: number }>) {
      const det = await fetch(`http://localhost:3000/runs/${r.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!det.ok) continue;
      const detail = await det.json();
      for (const spec of detail.specs ?? []) {
        for (const t of spec.tests ?? []) {
          if (typeof t.title !== "string" || !t.title.includes(criteria.titleFragment)) continue;
          if (criteria.needsCode && !t.test_code) continue;
          if (criteria.needsMetadata && !t.metadata) continue;
          if (criteria.needsCommandLog && !t.command_log) continue;
          return { runId: r.id, testId: t.id };
        }
      }
    }
    return null;
  }, match);
  expect(
    result,
    `expected a run/test matching ${JSON.stringify(match)}`,
  ).toBeTruthy();
  return result!;
}

export async function openModalForTest(
  page: Page,
  runId: number,
  testTitle: string,
): Promise<void> {
  // ?status=all overrides the route's Feature 1 (auto-filter to failed
  // when run.failed > 0). Without it, passing tests in passing specs
  // are filtered out of the rendered tree entirely. We still have to
  // manually expand passing spec sections (Feature 2 collapses them).
  await page.goto(`/runs/${runId}?status=all`);
  // The polished detail header lands the run id as a meta-row chip,
  // not an <h1>. Wait on that chip as evidence of load.
  await expect(
    page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
  ).toBeVisible({ timeout: 10_000 });

  const testButton = page.getByRole("button", { name: testTitle, exact: true });
  if (!(await testButton.first().isVisible().catch(() => false))) {
    // Expand every spec section so the test row mounts.
    const specHeaders = page.locator(".spec-header");
    const n = await specHeaders.count();
    for (let i = 0; i < n; i++) {
      await specHeaders.nth(i).click();
    }
  }
  await expect(testButton.first()).toBeVisible({ timeout: 5_000 });
  await testButton.first().click();
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
}
