import { expect, test, type Page } from "../fixtures/test";

import { ADMIN_USER, VIEWER_USER, WORKER_USERS } from "../fixtures/users";

/**
 * Critical, previously-untested /settings behaviours. The existing
 * settings specs cover API-key CRUD, quarantine, integrations, and the
 * team invite form; this file fills the gaps that most protect against
 * a real security regression:
 *
 *   1. RBAC gating for a genuine viewer (VIEWER_USER, org_members.role
 *      = 'viewer' in Acme). Two layers, asserted together:
 *        a. the UI hides every admin-only affordance (the admin-only
 *           sub-nav sections, the invite form, the per-member role
 *           select + remove button); and
 *        b. the backend *rejects* the privileged mutation even when the
 *           request is forged past the missing UI (defence-in-depth) —
 *           a viewer PATCH/DELETE against /orgs/:id/members/:userId must
 *           403, not silently succeed.
 *
 *   2. The owner's member-management control surface actually renders
 *      for an owner (the positive side of (1a)) — proving the
 *      isOwner/isAdmin derivation wires up, not just that it hides for
 *      a viewer.
 *
 *   3. Webhook lifecycle through the real UI (create → pause → test →
 *      delete). settings.spec only asserts the *form* mounts; this
 *      drives the full mutate-and-reload cycle so a regression in the
 *      list rendering or the pause/delete handlers is caught. Pinned to
 *      this agent's worker tenant (acme-w2) so the writes never collide.
 */

function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

const BACKEND = "http://localhost:3000";

/* ───────────── 1. Viewer RBAC — UI hides + backend rejects ───────────── */

test.describe("/settings — viewer is denied admin affordances (UI + API)", () => {
  test.use({ storageState: VIEWER_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    // Gate on the route's real readiness signal, not a sleep.
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 10_000 });
  });

  test("admin-only sub-nav sections are not rendered for a viewer", async ({ page }) => {
    const subnav = page.getByRole("complementary", { name: "Settings sections" });

    // Non-admin sections a viewer SHOULD see.
    await expect(subnav.getByRole("link", { name: "Connections" })).toBeVisible();
    await expect(subnav.getByRole("link", { name: "Team" })).toBeVisible();
    await expect(subnav.getByRole("link", { name: "API keys" })).toBeVisible();

    // Admin-only sections (navItems marked adminOnly) must be filtered
    // out of visibleNav for a viewer.
    for (const adminLabel of ["Suites", "Notifications", "PR comments", "Flaky automation", "Data retention", "Audit log"]) {
      await expect(
        subnav.getByRole("link", { name: adminLabel, exact: true }),
        `viewer must not see the '${adminLabel}' settings section`,
      ).toHaveCount(0);
    }
  });

  test("viewer sees the team list but no invite form and no per-member controls", async ({ page }) => {
    // The member list renders for everyone (read access).
    const teamSection = page.locator("#team");
    await expect(teamSection).toBeVisible();
    // The viewer's own membership is in the list.
    await expect(teamSection.getByText(VIEWER_USER.email)).toBeVisible();

    // Invite form is admin-only ({#if isAdmin}) — the email box must
    // not exist for a viewer.
    await expect(page.getByPlaceholder("Email address")).toHaveCount(0);

    // The per-member role <select> + remove button are gated on
    // {#if isOwner}; a viewer sees neither anywhere on the page.
    await expect(teamSection.locator("select.inline-select")).toHaveCount(0);
    await expect(teamSection.getByRole("button", { name: "Remove" })).toHaveCount(0);
  });

  test("viewer cannot change a member's role — backend 403s the PATCH (defence-in-depth)", async ({ page }) => {
    const token = await getToken(page);
    const orgId = await page.evaluate(() => {
      const u = localStorage.getItem("bt_user");
      return u ? (JSON.parse(u).orgId as number) : null;
    });
    expect(orgId, "viewer session should carry an orgId").not.toBeNull();

    // Discover the owner member to target (the privileged victim row).
    const membersRes = await page.request.get(`${BACKEND}/orgs/${orgId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(membersRes.status()).toBe(200);
    const members = (await membersRes.json()) as { id: number; role: string; email: string }[];
    const owner = members.find((m) => m.role === "owner");
    expect(owner, "Acme should have an owner member to target").toBeTruthy();

    // Forge the PATCH the UI never offers. A viewer must be rejected.
    const patchRes = await page.request.patch(`${BACKEND}/orgs/${orgId}/members/${owner!.id}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { role: "viewer" },
    });
    expect(
      patchRes.status(),
      "a viewer must not be able to demote the owner — role changes are owner-only",
    ).toBe(403);

    // And the owner is unchanged afterwards (the mutation truly didn't land).
    const after = (await (
      await page.request.get(`${BACKEND}/orgs/${orgId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { id: number; role: string }[];
    expect(after.find((m) => m.id === owner!.id)?.role).toBe("owner");
  });

  test("viewer cannot remove a member — backend 403s the DELETE", async ({ page }) => {
    const token = await getToken(page);
    const orgId = await page.evaluate(() => {
      const u = localStorage.getItem("bt_user");
      return u ? (JSON.parse(u).orgId as number) : null;
    });
    const members = (await (
      await page.request.get(`${BACKEND}/orgs/${orgId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { id: number; role: string }[];
    const owner = members.find((m) => m.role === "owner")!;

    const delRes = await page.request.delete(`${BACKEND}/orgs/${orgId}/members/${owner.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(
      delRes.status(),
      "a viewer must not be able to remove another member — removal is admin/owner-only",
    ).toBe(403);

    // The member is still present.
    const after = (await (
      await page.request.get(`${BACKEND}/orgs/${orgId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { id: number }[];
    expect(after.find((m) => m.id === owner.id), "the owner must still be a member").toBeTruthy();
  });
});

/* ───────────── 2. Owner DOES see the member-management controls ───────────── */

test.describe("/settings — owner sees the member-management controls", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("an owner sees the invite form and a role select + remove button for a non-owner member", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 10_000 });

    // The positive side of the viewer test: an owner sees the invite form.
    await expect(page.getByPlaceholder("Email address")).toBeVisible();

    // Acme seeds a viewer member (viewer@example.com) under the owner.
    // Its row must carry the inline role <select> + a Remove button
    // (rendered only {#if isOwner && m.id !== self}). Read-only — no
    // mutation, so this is collision-safe against the shared Acme org.
    const teamSection = page.locator("#team");
    const viewerRow = teamSection.locator(".list-row", { hasText: VIEWER_USER.email });
    await expect(viewerRow).toBeVisible();
    await expect(viewerRow.locator("select.inline-select")).toBeVisible();
    // The select reflects the seeded viewer role.
    await expect(viewerRow.locator("select.inline-select")).toHaveValue("viewer");
    await expect(viewerRow.getByRole("button", { name: "Remove" })).toBeVisible();
  });
});

/* ───────────── 3. Webhook lifecycle through the UI (acme-w2) ───────────── */

test.describe("/settings — webhook create / pause / test / delete (UI)", () => {
  // Pin to this agent's worker tenant so the write-heavy lifecycle
  // never collides with other agents.
  test.use({ storageState: WORKER_USERS[2].storageStatePath });

  test("create a webhook, pause it, run a test delivery, then delete it", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/settings");
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible({ timeout: 10_000 });

    const notif = page.locator("#notifications");
    await expect(notif).toBeVisible();

    // An unreachable-but-public-looking host: passes create-time URL
    // validation (dev allows non-public hosts) and makes the later
    // "Test" delivery resolve deterministically to a failure (DNS
    // never resolves) rather than depending on a live sink.
    const whName = `e2e-wh-${Date.now().toString(36)}`;
    const whUrl = `https://${whName}.example.invalid/hook`;

    await notif.getByPlaceholder("Name (optional)").fill(whName);
    await notif.getByPlaceholder("Webhook URL").fill(whUrl);
    await notif.getByRole("button", { name: /^Add$/ }).click();

    // The new webhook row appears, Active by default.
    const row = notif.locator(".list-row", { hasText: whName });
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.locator(".pill", { hasText: /^Active$/ })).toBeVisible();

    // Pause it — the row flips to a Paused pill and the button becomes "Enable".
    await row.getByRole("button", { name: /^Pause$/ }).click();
    await expect(row.locator(".pill", { hasText: /^Paused$/ })).toBeVisible({ timeout: 5_000 });
    await expect(row.getByRole("button", { name: /^Enable$/ })).toBeVisible();

    // Run a test delivery. The button text settles to "Sent" or
    // "Failed" once the POST /webhooks/:id/test resolves — a real
    // signal, not a sleep. The unreachable host makes "Failed" the
    // honest, deterministic outcome.
    await row.getByRole("button", { name: /^Test$/ }).click();
    await expect(
      row.getByRole("button", { name: /^Failed$/ }),
      "test delivery to an unreachable host should report Failed",
    ).toBeVisible({ timeout: 10_000 });

    // Delete it (✕ icon button, title="Delete"). No confirm modal on
    // webhook delete — the handler fires straight away.
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(notif.locator(".list-row", { hasText: whName })).toHaveCount(0, { timeout: 5_000 });
  });
});
