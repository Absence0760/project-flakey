import { expect, test, type Page } from "../fixtures/test";

/**
 * /releases/<id> — the Jira "fix version" panel.
 *
 * INVARIANT PROTECTED
 * ===================
 * When an org has Jira configured, the release detail page renders a Jira
 * panel (`section.jira`, +page.svelte:1643-1722) that:
 *   - in the MATCHED state, shows the pinned fix version (project_key / name),
 *     its released/overdue status, the fixed/affected issue counts, and the
 *     issue list (key → summary → status → assignee), with a "Clear match"
 *     affordance;
 *   - in the UNMATCHED state, explains no version matched and offers the
 *     available Jira versions to pin, wiring each row to
 *     POST /releases/:id/jira/match with { version_id, version_name };
 *   - flips between the two as the user pins / clears a match (each action
 *     re-fetches GET /releases/:id/jira).
 *
 * WHY MOCK JIRA
 * =============
 * There is no local Jira (no `pnpm jira:up` equivalent) and the e2e seed has
 * no configured Jira integration, so a real end-to-end against Atlassian is
 * out of reach here. This spec route-mocks the backend's Jira endpoints to
 * exercise the FRONTEND panel contract — render branches, the exact match
 * request payload, and the pin→match / clear→unmatch state transitions. It
 * deliberately does NOT cover the backend's real version-matching logic
 * (that's the integrations layer's responsibility, exercised via the
 * settings/integrations specs + backend tests). A real release is created so
 * everything ELSE on the page loads against the live backend; only the two
 * /jira routes are intercepted.
 *
 * DETERMINISM
 * ===========
 * The /jira GET is backed by a closure `matched` flag the match/clear routes
 * flip, so the pin/clear flows resolve against a real (mocked) round-trip —
 * no sleeps, no arbitrary timeouts. Each assertion waits on a real render
 * signal (the version-name link, the counts, the version-list rows).
 */

const API = "http://localhost:3000";

const PROJECT_KEY = "FLK";
const VERSION_NAME = "9.9.0-e2e";
const BROWSE_URL = "https://example.atlassian.net/projects/FLK/versions/10001";

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
  return token;
}

async function createRelease(page: Page, token: string): Promise<number> {
  const version = `e2e-jira-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const res = await page.request.post(`${API}/releases`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { version, name: "e2e jira panel" },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  return (await res.json()).id as number;
}

async function deleteRelease(page: Page, token: string, id: number): Promise<void> {
  await page.request
    .delete(`${API}/releases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {});
}

const MATCHED_VERSION = {
  id: "10001",
  name: VERSION_NAME,
  released: false,
  archived: false,
  releaseDate: "2026-07-01",
  overdue: false,
};

function matchedPayload() {
  return {
    configured: true,
    matched: true,
    project_key: PROJECT_KEY,
    browse_url: BROWSE_URL,
    version: MATCHED_VERSION,
    counts: { issuesFixedCount: 3, issuesAffectedCount: 1 },
    issues: [
      {
        key: "FLK-101",
        url: "https://example.atlassian.net/browse/FLK-101",
        summary: "Login button misaligned on mobile",
        status: "Done",
        statusCategory: "done",
        assignee: "Ada Lovelace",
      },
      {
        key: "FLK-102",
        url: "https://example.atlassian.net/browse/FLK-102",
        summary: "Flaky checkout retry loop",
        status: "In Progress",
        statusCategory: "indeterminate",
        assignee: null,
      },
    ],
  };
}

function unmatchedPayload(releaseVersion: string) {
  return {
    configured: true,
    matched: false,
    project_key: PROJECT_KEY,
    release_version: releaseVersion,
    available_versions: [
      { id: "10001", name: VERSION_NAME, released: false, archived: false, releaseDate: "2026-07-01" },
      { id: "10002", name: "8.0.0", released: true, archived: false, releaseDate: "2026-01-15" },
    ],
  };
}

/**
 * Install the stateful Jira mocks. `matched` starts at `start`; POST
 * /jira/match flips it true (and captures the body), DELETE flips it false.
 * GET /jira returns the matched/unmatched payload for the current flag.
 * Returns a getter for the last captured match-request body.
 */
async function mockJira(
  page: Page,
  releaseVersion: string,
  start: boolean,
): Promise<{ lastMatchBody: () => unknown }> {
  let matched = start;
  let lastBody: unknown = null;

  // GET /releases/:id/jira — disjoint from /jira/match (extra path segment).
  await page.route("**/releases/*/jira", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(matched ? matchedPayload() : unmatchedPayload(releaseVersion)),
    });
  });

  await page.route("**/releases/*/jira/match", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      lastBody = route.request().postDataJSON();
      matched = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    } else if (method === "DELETE") {
      matched = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    } else {
      await route.fallback();
    }
  });

  return { lastMatchBody: () => lastBody };
}

test.describe("/releases/<id> — Jira fix-version panel", () => {
  test("matched version renders counts + issues; Clear match unpins to the version picker", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token);

    try {
      await mockJira(page, VERSION_NAME, /* start matched */ true);
      await page.goto(`/releases/${releaseId}`);

      const jira = page.locator("section.jira");
      await expect(jira.getByRole("heading", { name: "Jira release" })).toBeVisible();

      // Pinned version: project_key / name, linked to the browse URL.
      const versionLink = jira.locator("a.jira-version-name");
      await expect(versionLink).toHaveText(`${PROJECT_KEY} / ${VERSION_NAME}`);
      await expect(versionLink).toHaveAttribute("href", BROWSE_URL);
      await expect(jira.locator(".jira-sub")).toContainText("Unreleased");

      // Counts come straight from the payload.
      const counts = jira.locator(".jira-counts");
      await expect(counts).toContainText("3");
      await expect(counts).toContainText("fixed");
      await expect(counts).toContainText("1");
      await expect(counts).toContainText("affected");

      // Issue list: one row per issue, key → summary → status, assignee when present.
      const issues = jira.locator("ul.jira-issues > li");
      await expect(issues).toHaveCount(2);
      const first = issues.filter({ hasText: "FLK-101" });
      await expect(first.locator("a.issue-key")).toHaveText("FLK-101");
      await expect(first.locator(".issue-summary")).toHaveText("Login button misaligned on mobile");
      await expect(first.locator(".issue-status")).toHaveText("Done");
      await expect(first.locator(".issue-assignee")).toHaveText("Ada Lovelace");
      // Status category drives the row class (used for colour-coding).
      await expect(first).toHaveClass(/jira-cat-done/);
      // Second issue has no assignee → no assignee span.
      const second = issues.filter({ hasText: "FLK-102" });
      await expect(second.locator(".issue-assignee")).toHaveCount(0);

      // Clear match → DELETE /jira/match → re-fetch flips to the unmatched picker.
      await jira.getByRole("button", { name: "Clear match" }).click();
      await expect(jira.locator("ul.version-list")).toBeVisible();
      await expect(jira.locator("a.jira-version-name")).toHaveCount(0);
      await expect(jira.locator(".empty")).toContainText("No Jira version matches");
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });

  test("unmatched panel offers available versions; pinning one sends the match payload and flips to matched", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const releaseId = await createRelease(page, token);

    try {
      const { lastMatchBody } = await mockJira(page, VERSION_NAME, /* start matched */ false);
      await page.goto(`/releases/${releaseId}`);

      const jira = page.locator("section.jira");
      await expect(jira.getByRole("heading", { name: "Jira release" })).toBeVisible();

      // Unmatched: the picker lists the available versions.
      const rows = jira.locator("ul.version-list button.picker-row");
      await expect(rows).toHaveCount(2);
      const target = rows.filter({ hasText: VERSION_NAME });
      await expect(target).toHaveCount(1);

      // Pin it → POST /jira/match → loadJira() → matched branch renders.
      await target.click();
      await expect(jira.locator("a.jira-version-name")).toHaveText(`${PROJECT_KEY} / ${VERSION_NAME}`);
      await expect(jira.locator(".jira-counts")).toBeVisible();

      // The frontend sent the exact pin payload the backend expects.
      expect(lastMatchBody()).toEqual({ version_id: "10001", version_name: VERSION_NAME });
    } finally {
      await deleteRelease(page, token, releaseId);
    }
  });
});
