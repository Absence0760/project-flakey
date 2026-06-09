import { expect, test } from "../fixtures/test";

/**
 * /settings → Connections — the "Test connection" diagnostics.
 *
 * The Connections strip on the settings page exposes four cards
 * (Database / Git Provider / Email / AI Analysis), each backed by a
 * POST probe in the backend:
 *
 *   - DB    → POST /connectivity/database  (src/routes/connectivity.ts)
 *   - Email → POST /connectivity/email     (sends a verification mail to
 *             the signed-in user via the configured SMTP transport)
 *   - Git   → POST /connectivity/git       (reads org git_* settings, then
 *             hits the provider API)
 *   - AI    → POST /analyze/test-connection (asks the configured provider
 *             to reply "ok")
 *
 * What's deterministic on the local e2e stack (and therefore what we
 * assert) — verified against the live backend, not assumed:
 *
 *   - Postgres is up  → DB probe reports ok (version · db · size · latency).
 *   - Mailpit SMTP is up on :1025 → email probe reports ok ("Sent to <me>").
 *   - No org git provider is seeded → the Git card renders "Not configured"
 *     and exposes NO test button (the route would return
 *     {ok:false,"Git provider not configured"}, but the UI gates the button
 *     behind has_git_token, so the deterministic UI state is the absence of
 *     the button — that's what we pin).
 *   - AI is config-enabled (AI_PROVIDER/AI_BASE_URL set → /analyze/status
 *     enabled:true → the Test button renders) but the Ollama endpoint it
 *     points at is NOT running on the e2e stack, so the probe deterministically
 *     fails with the fixed string "AI provider connection failed". We assert
 *     the fail STATE (.conn-result.fail) rather than a flaky "maybe ok" — the
 *     error string is a fixed constant in ai.ts:testConnection(), not nondet.
 *
 * Each result renders into `.conn-result` (with `.ok`/`.fail` modifier
 * classes) inside the relevant `.conn-card`. The card has no live network
 * dependency until the button is clicked, so we wait on the result element
 * itself as the real readiness signal — no sleeps.
 *
 * This runs on the per-worker `acme-w<N>` tenant (default `test` import), so
 * the email probe's recipient is the worker admin (`admin+w<N>@example.com`).
 * We assert the domain (`@example.com`) — the local part legitimately varies
 * by worker, which is real tenant variance, not a loosened assertion.
 */

// Locate a connection card by its <h3> heading text.
function connCard(page: import("@playwright/test").Page, heading: string) {
  return page.locator(".conn-card").filter({
    has: page.getByRole("heading", { level: 3, name: heading }),
  });
}

test.describe("/settings → Connections — test-connection probes (admin)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    // Real load-complete signal exposed by the route (see README → readiness
    // signals): flips once onMount loaders settle. Gate on it before driving
    // buttons so aiStatus (which decides whether the AI test button renders)
    // has resolved.
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
  });

  test("Database probe reports ok against the live Postgres", async ({ page }) => {
    const card = connCard(page, "Database");
    await card.getByRole("button", { name: "Test connection" }).click();

    // Wait on the result element (real signal — appears only once the POST
    // resolves and the component re-renders), then assert the ok state.
    const result = card.locator(".conn-result");
    await expect(result).toBeVisible();
    await expect(result).toHaveClass(/\bok\b/);
    // The ok row renders "<version> · <database> · <size>MB · <latency>ms".
    // Assert the deterministic, environment-stable fragments.
    await expect(result).toContainText("PostgreSQL");
    await expect(result).toContainText("ms");
  });

  test("Email probe reports ok against the live Mailpit SMTP sink", async ({ page }) => {
    const card = connCard(page, "Email");
    await card.getByRole("button", { name: "Send test email" }).click();

    const result = card.locator(".conn-result");
    await expect(result).toBeVisible();
    await expect(result).toHaveClass(/\bok\b/);
    // Renders "Sent to <signed-in user email>". The local part varies by
    // worker tenant; the domain is fixed by the seed.
    await expect(result).toContainText("Sent to");
    await expect(result).toContainText("@example.com");
  });

  test("AI probe reports a deterministic failure (provider configured, endpoint down)", async ({
    page,
  }) => {
    // AI is config-enabled on the e2e stack (AI_BASE_URL is set), so the Test
    // button renders. The Ollama backend it targets isn't running here, so the
    // probe fails with the fixed string from ai.ts:testConnection().
    const card = connCard(page, "AI Analysis");
    const button = card.getByRole("button", { name: "Test connection" });
    await expect(button).toBeVisible();
    await button.click();

    const result = card.locator(".conn-result");
    await expect(result).toBeVisible();
    await expect(result).toHaveClass(/\bfail\b/);
    // Fixed constant — never echoes provider detail (see connectivity contract).
    await expect(result).toHaveText("AI provider connection failed");
  });

  test("Git card shows 'Not configured' with no test button (no provider seeded)", async ({
    page,
  }) => {
    // No git provider is seeded, so the UI gates the test button behind
    // has_git_token and shows the unconfigured affordance instead. The
    // deterministic UI contract here is: the marker is present and the
    // button is absent.
    const card = connCard(page, "Git Provider");
    await expect(card.locator(".conn-unconfigured")).toHaveText("Not configured");
    await expect(card.getByRole("button", { name: "Test connection" })).toHaveCount(0);
  });
});
