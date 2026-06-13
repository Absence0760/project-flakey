import { expect, test, type Page } from "../fixtures/test";


/**
 * NotesPanel (shared component, mounted on /runs/<id>, /errors, /flaky,
 * /slowest) renders user-authored note bodies through `{@html
 * renderBodySafe(...)}` — a security-sensitive path that autolinks URLs
 * and then runs the result through DOMPurify. It's reused everywhere
 * but never directly exercised end-to-end.
 *
 * These post real notes (full DB round-trip) on the run-detail notes
 * panel and assert on the rendered DOM:
 *   - http(s) + bare-www URLs autolink to safe anchors,
 *   - trailing sentence punctuation is excluded from the link,
 *   - markup / script / javascript: payloads are neutralised (no live
 *     element, no dialog) — defence for the {@html} sink.
 *
 * Each note carries a unique nonce so the assertion targets exactly the
 * note this test posted (the panel is additive across the worker seed).
 */

async function openRunNotes(page: Page) {
  await page.goto("/runs");
  const firstRow = page.locator("tr.run-row").first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  const runId = Number(await firstRow.getAttribute("data-run-id"));
  await page.goto(`/runs/${runId}?status=all`);

  const runNotes = page.locator(".run-notes");
  await expect(runNotes).toBeVisible({ timeout: 10_000 });
  // Compact mode: collapsed behind a toggle button.
  await runNotes.locator("button.toggle").click();
  await expect(runNotes.getByPlaceholder("Add a note...")).toBeVisible();
  return runNotes;
}

async function postNote(runNotes: ReturnType<Page["locator"]>, body: string) {
  await runNotes.getByPlaceholder("Add a note...").fill(body);
  await runNotes.getByRole("button", { name: /^Post$/ }).click();
}

function nonce(): string {
  // Spec-local unique marker; Date.now() is allowed in test files.
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

test.describe("NotesPanel — URL autolinking", () => {

  test("an http(s) URL renders as a safe new-tab anchor", async ({ page }) => {
    const runNotes = await openRunNotes(page);
    const id = nonce();
    await postNote(runNotes, `${id} check https://example.com/path?x=1`);

    const noteBody = runNotes.locator(".note-body", { hasText: id });
    await expect(noteBody).toBeVisible({ timeout: 5_000 });

    const link = noteBody.locator("a", { hasText: "https://example.com/path" });
    await expect(link).toHaveAttribute("href", "https://example.com/path?x=1");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });

  test("trailing sentence punctuation is excluded from the linked URL", async ({ page }) => {
    const runNotes = await openRunNotes(page);
    const id = nonce();
    await postNote(runNotes, `${id} see https://example.com.`);

    const noteBody = runNotes.locator(".note-body", { hasText: id });
    await expect(noteBody).toBeVisible({ timeout: 5_000 });

    // The href stops before the period; the period stays as text.
    const link = noteBody.locator("a");
    await expect(link).toHaveAttribute("href", "https://example.com");
    await expect(noteBody).toContainText("https://example.com.");
  });

  test("a bare www. URL is linked with an https:// scheme prepended", async ({ page }) => {
    const runNotes = await openRunNotes(page);
    const id = nonce();
    await postNote(runNotes, `${id} visit www.example.org/docs`);

    const noteBody = runNotes.locator(".note-body", { hasText: id });
    await expect(noteBody).toBeVisible({ timeout: 5_000 });
    await expect(noteBody.locator("a")).toHaveAttribute("href", "https://www.example.org/docs");
  });
});

test.describe("NotesPanel — XSS safety of the {@html} sink", () => {

  test("script / img-onerror / javascript: payloads render inert (no live node, no dialog)", async ({ page }) => {
    // Any alert()/confirm() firing means a payload executed — fail loud.
    let dialogFired = false;
    page.on("dialog", async (d) => { dialogFired = true; await d.dismiss(); });

    const runNotes = await openRunNotes(page);
    const id = nonce();
    // A grab-bag of the classic injection shapes for a {@html} sink.
    await postNote(
      runNotes,
      `${id} <script>alert('xss')</script> <img src=x onerror="alert('xss')"> <a href="javascript:alert('xss')">x</a>`,
    );

    const noteBody = runNotes.locator(".note-body", { hasText: id });
    await expect(noteBody).toBeVisible({ timeout: 5_000 });

    // No live <script> or <img> element was injected into the body.
    await expect(noteBody.locator("script")).toHaveCount(0);
    await expect(noteBody.locator("img")).toHaveCount(0);

    // If any anchor survived (DOMPurify keeps <a>), its href must not use a
    // script-executing scheme — javascript:, but also data: and vbscript:,
    // which are equally dangerous and which a javascript:-only check would
    // miss (CodeQL js/incomplete-url-scheme-check). Normalise leading/embedded
    // whitespace first, since `java\tscript:` parses as a live scheme.
    const anchors = noteBody.locator("a");
    for (let i = 0; i < (await anchors.count()); i++) {
      const href = (await anchors.nth(i).getAttribute("href")) ?? "";
      const scheme = href.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
      expect(
        scheme.startsWith("javascript:") ||
          scheme.startsWith("data:") ||
          scheme.startsWith("vbscript:"),
        "anchor href must not use a script-executing URL scheme",
      ).toBe(false);
    }

    // The escaped markup is shown as visible text, proving it was
    // neutralised rather than parsed.
    await expect(noteBody).toContainText("<script>");

    // Any executing payload (sync on render, or async from a broken
    // <img onerror>) would have fired a dialog during the awaited
    // assertions above. DOMPurify strips the <img> so it never loads —
    // there's no pending async load to wait on; assert nothing fired.
    expect(dialogFired, "no injected payload should trigger a dialog").toBe(false);
  });
});
