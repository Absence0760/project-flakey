import { expect, test } from "../fixtures/test";


/**
 * /errors master/detail split — the auto-select recovery invariant.
 *
 * The right-hand detail pane is driven by selectedFingerprint, which an
 * effect keeps valid against the *filtered* list: on load it picks the
 * first error; when a search narrows the list such that the current
 * selection drops out, it falls through to the new top match; when
 * nothing matches it clears. The pane must therefore never go stale
 * (showing an error no longer in the list) or blank-while-results-exist.
 *
 * This invariant is load-bearing for the page's usability but untested.
 */

test.describe("/errors — master/detail selection", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/errors");
    await expect(page.locator(".error-list, .empty").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".status-text", { hasText: "Loading..." })).toHaveCount(0);
    await expect(page.locator(".error-item").first()).toBeVisible({ timeout: 5_000 });
  });

  test("on load the first error is auto-selected and the detail pane mirrors it", async ({ page }) => {
    // Exactly one active row, and the detail <pre> shows that row's message.
    await expect(page.locator(".error-item.active")).toHaveCount(1);
    const activeMsg = (await page.locator(".error-item.active .error-msg").textContent())?.trim() ?? "";
    expect(activeMsg.length).toBeGreaterThan(0);

    const detail = page.locator(".detail-pane .detail-error");
    await expect(detail).toBeVisible();
    // The list truncates with title/ellipsis; assert the detail contains
    // the (possibly-longer) full message starting with the same text.
    const detailText = (await detail.textContent())?.trim() ?? "";
    expect(detailText.startsWith(activeMsg) || activeMsg.startsWith(detailText.slice(0, 20))).toBe(true);
  });

  test("a search keeps the selection valid — recovers to the new top match, never stale", async ({ page }) => {
    // Find a search token that appears in some error other than the
    // currently-selected first one, and is absent from the first — so
    // the search is guaranteed to filter the selection OUT and force a
    // recovery to a different error.
    const probe = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll(".error-item .error-msg"))
        .map((el) => (el.textContent ?? "").trim());
      if (msgs.length < 2) return null;
      const first = msgs[0].toLowerCase();
      for (let i = 1; i < msgs.length; i++) {
        for (const word of msgs[i].split(/[^A-Za-z]+/)) {
          if (word.length >= 5 && !first.includes(word.toLowerCase())) {
            return { token: word };
          }
        }
      }
      return null;
    });
    test.skip(!probe, "seed lacked two errors with a distinguishing token");

    const token = probe!.token;
    await page.getByPlaceholder("Search error messages...").fill(token);

    // Still exactly one active row, it's in the (narrowed) visible list,
    // and the detail pane reflects it — i.e. selection recovered rather
    // than going stale or blank.
    await expect(page.locator(".error-item.active")).toHaveCount(1);
    const activeMsg = (await page.locator(".error-item.active .error-msg").textContent() ?? "").toLowerCase();
    expect(activeMsg).toContain(token.toLowerCase());

    const detailText = ((await page.locator(".detail-pane .detail-error").textContent()) ?? "").toLowerCase();
    expect(detailText).toContain(token.toLowerCase());
  });

  test("a no-match search replaces the whole split with the empty state (no stale detail)", async ({ page }) => {
    await page.getByPlaceholder("Search error messages...").fill("zzz-no-such-error-message-qqq");

    // When filteredErrors is empty the entire master/detail split is
    // torn down for a full-width empty block — so neither a list row nor
    // a stale .detail-error from the prior selection can survive.
    await expect(page.locator(".error-item")).toHaveCount(0);
    await expect(page.locator(".detail-pane")).toHaveCount(0);
    await expect(page.locator(".empty")).toBeVisible();
    await expect(page.locator(".empty")).toContainText("No messages match");
  });
});
