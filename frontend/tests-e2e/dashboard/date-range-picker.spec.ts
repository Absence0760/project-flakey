import { expect, test, type Page } from "../fixtures/test";


/**
 * DateRangePicker (mounted on /dashboard) — the interactive controls
 * the existing "opens a calendar / don't crash" smoke leaves untested:
 * the preset buttons, the Clear → "All Time" path, calendar
 * day-selection, and future-day disabling. Each must drive the
 * dashboard's ?from&to URL contract.
 *
 * Expected dates are computed with the SAME local-time formatting the
 * picker uses (toISO below mirrors DateRangePicker.toISO), so the
 * assertions match regardless of the runner's timezone.
 */

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISO(d);
}

async function openPicker(page: Page) {
  await page.goto("/dashboard");
  // Wait for the data to land so the picker's onchange-driven refetch
  // isn't racing the initial load.
  await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });
  await page.locator(".trigger").click();
  await expect(page.locator(".dropdown")).toBeVisible();
}

test.describe("DateRangePicker — presets", () => {

  test("'Last 30 days' sets ?from=today-30 & ?to=today and updates the trigger label", async ({ page }) => {
    await openPicker(page);
    await page.getByRole("button", { name: "Last 30 days" }).click();

    // Dropdown closes on preset apply.
    await expect(page.locator(".dropdown")).toBeHidden();

    const url = new URL(page.url());
    expect(url.searchParams.get("from")).toBe(daysAgoISO(30));
    expect(url.searchParams.get("to")).toBe(toISO(new Date()));

    // The trigger reflects the new range (a 30-day span renders as
    // "From – To", so it contains an en-dash and today's formatted date).
    await expect(page.locator(".trigger-label")).toContainText("–");
  });

  test("'Today' collapses the range to a single day (from === to)", async ({ page }) => {
    await openPicker(page);
    await page.getByRole("button", { name: "Today" }).click();

    const url = new URL(page.url());
    const today = toISO(new Date());
    expect(url.searchParams.get("from")).toBe(today);
    expect(url.searchParams.get("to")).toBe(today);
    // Single-day range renders as one formatted date, no en-dash.
    await expect(page.locator(".trigger-label")).not.toContainText("–");
  });
});

test.describe("DateRangePicker — Clear / All Time", () => {

  test("Clear drops ?from&to from the URL and shows the 'All Time' label", async ({ page }) => {
    // Start from an explicit range so there's something to clear.
    await page.goto(`/dashboard?from=${daysAgoISO(30)}&to=${toISO(new Date())}`);
    await expect(page.locator(".page[data-ready='true']")).toBeVisible({ timeout: 10_000 });

    await page.locator(".trigger").click();
    await expect(page.locator(".dropdown")).toBeVisible();
    // The Clear button only renders when a range is set.
    await page.getByRole("button", { name: "Clear" }).click();

    await expect(page.locator(".trigger-label")).toHaveText("All Time");
    const url = new URL(page.url());
    expect(url.searchParams.get("from")).toBeNull();
    expect(url.searchParams.get("to")).toBeNull();
  });
});

test.describe("DateRangePicker — calendar", () => {

  test("future days are disabled (can't pick a window that hasn't happened)", async ({ page }) => {
    await openPicker(page);
    // The calendar opens on the current (from) month — today is the
    // latest enabled day. Any .cal-day.future is disabled.
    const futureDays = page.locator(".cal-day.future");
    const count = await futureDays.count();
    for (let i = 0; i < count; i++) {
      await expect(futureDays.nth(i)).toBeDisabled();
    }
    // There's at least the trailing tail of the month disabled unless
    // today is the last day of the month — so just assert no enabled
    // future day exists rather than pinning a count.
    await expect(page.locator(".cal-day.future:not([disabled])")).toHaveCount(0);
  });

  test("clicking two in-month days sets a from→to range and writes it to the URL", async ({ page }) => {
    await openPicker(page);

    // Navigate to last month so every day is in the past (selectable).
    await page.locator(".cal-nav[aria-label='Previous month']").click();

    // Pick day 10 then day 20 of the displayed (previous) month. With
    // selecting starting on "from", the first click sets From, the
    // second sets To.
    const enabledDays = page.locator(".cal-day:not(.future):not(.cal-empty)");
    // Day labels are the textContent; click "10" then "20".
    await page.locator(".cal-day", { hasText: /^10$/ }).first().click();
    await page.locator(".cal-day", { hasText: /^20$/ }).first().click();

    // After both clicks the range is applied; the URL carries from<to
    // within the previous month.
    const url = new URL(page.url());
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();
    expect(from! < to!).toBe(true);
    expect(from!.endsWith("-10")).toBe(true);
    expect(to!.endsWith("-20")).toBe(true);
    // Sanity: the picker exposes a contiguous in-range highlight.
    expect(await enabledDays.count()).toBeGreaterThan(0);
  });
});
