import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo, absoluteDate, calendarDate, formatDuration } from "./format.js";

describe("timeAgo", () => {
  const NOW = new Date("2026-05-31T12:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR;

  it("renders an em dash for falsy input", () => {
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo(undefined)).toBe("—");
    expect(timeAgo("")).toBe("—");
  });

  it("renders an em dash for an unparseable date (not 'NaNy ago')", () => {
    // Regression: timeAgo lacked the NaN guard its siblings carry, so a bad
    // timestamp fell through every tier and emitted "NaNy ago".
    expect(timeAgo("not-a-date")).toBe("—");
    expect(timeAgo("2026-13-99")).toBe("—");
    expect(timeAgo("garbage")).toBe("—");
  });

  it("steps through the relative tiers", () => {
    expect(timeAgo(ago(10 * SEC))).toBe("just now");
    expect(timeAgo(ago(5 * MIN))).toBe("5m ago");
    expect(timeAgo(ago(3 * HR))).toBe("3h ago");
    expect(timeAgo(ago(1 * DAY))).toBe("yesterday");
    expect(timeAgo(ago(4 * DAY))).toBe("4d ago");
    expect(timeAgo(ago(60 * DAY))).toBe("2mo ago");
    expect(timeAgo(ago(400 * DAY))).toBe("1y ago");
  });

  it("flips at each tier boundary", () => {
    expect(timeAgo(ago(59 * SEC))).toBe("just now");
    expect(timeAgo(ago(60 * SEC))).toBe("1m ago");
    expect(timeAgo(ago(59 * MIN))).toBe("59m ago");
    expect(timeAgo(ago(60 * MIN))).toBe("1h ago");
    expect(timeAgo(ago(2 * DAY))).toBe("2d ago"); // upper side of "yesterday"
    expect(timeAgo(ago(29 * DAY))).toBe("29d ago");
    expect(timeAgo(ago(30 * DAY))).toBe("1mo ago");
    expect(timeAgo(ago(360 * DAY))).toBe("1y ago"); // 12 months → years
  });
});

describe("absoluteDate", () => {
  it("returns '' for falsy or unparseable input", () => {
    expect(absoluteDate(null)).toBe("");
    expect(absoluteDate(undefined)).toBe("");
    expect(absoluteDate("")).toBe("");
    expect(absoluteDate("not-a-date")).toBe("");
  });

  it("includes the year for a valid timestamp", () => {
    expect(absoluteDate("2026-05-31T12:00:00Z")).toContain("2026");
  });

  it("renders a full timestamp with both date and a clock time", () => {
    const iso = "2026-05-31T09:07:00Z";
    const out = absoluteDate(iso);
    // Date + time components: year, a numeric day, and a HH:MM clock.
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{1,2}:\d{2}/); // has a clock time, unlike calendarDate
    // The rendered day matches the locale render of the same Date (TZ-agnostic
    // assertion: we compare against the platform's own formatting of `iso`).
    const day = String(new Date(iso).getDate());
    expect(out).toContain(day);
  });
});

describe("calendarDate", () => {
  it("returns '' for falsy or unparseable input", () => {
    expect(calendarDate(null)).toBe("");
    expect(calendarDate(undefined)).toBe("");
    expect(calendarDate("not-a-date")).toBe("");
  });

  it("renders a date without a time component", () => {
    const out = calendarDate("2026-05-31T00:00:00Z");
    expect(out).toContain("2026");
    expect(out).not.toMatch(/\d:\d/); // no clock time
  });

  it("renders year-boundary dates with no off-by-one", () => {
    // Use noon UTC so the local-time render lands on the same calendar day
    // regardless of the runner's timezone offset, then assert against the
    // platform's own Date fields (TZ-agnostic).
    const nye = "2025-12-31T12:00:00Z";
    const nyd = "2026-01-01T12:00:00Z";

    const nyeOut = calendarDate(nye);
    const nyeDate = new Date(nye);
    expect(nyeOut).toContain(String(nyeDate.getFullYear()));
    expect(nyeOut).toContain(String(nyeDate.getDate()));

    const nydOut = calendarDate(nyd);
    const nydDate = new Date(nyd);
    expect(nydOut).toContain(String(nydDate.getFullYear()));
    expect(nydOut).toContain(String(nydDate.getDate()));

    // The two adjacent calendar days must not render identically.
    expect(nyeOut).not.toBe(nydOut);
  });

  it("renders the leap day (Feb 29, 2024) without rolling to Mar 1", () => {
    const iso = "2024-02-29T12:00:00Z";
    const out = calendarDate(iso);
    const d = new Date(iso);
    expect(out).toContain("2024");
    expect(out).toContain(String(d.getDate())); // 29
    // The locale's own rendering of the same Date — proves no rollover to a
    // different month/day inside formatDuration's date pipeline.
    expect(out).toBe(
      d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  });
});

describe("formatDuration", () => {
  it("formats across magnitudes", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(187_000)).toBe("3m 7s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });

  it("handles the unit boundaries", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(59_999)).toBe("60.0s"); // still sub-minute → seconds branch
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_600_000)).toBe("1h 0m"); // minutes kept even at zero
  });

  it("renders zero and tiny sub-second values in the ms branch", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(7)).toBe("7ms");
  });

  it("rounds inside the seconds branch to one decimal", () => {
    expect(formatDuration(1049)).toBe("1.0s"); // rounds down
    expect(formatDuration(1050)).toBe("1.1s"); // rounds up at the .05 tie
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("keeps the minutes segment at an exact-hour boundary and drops zero seconds", () => {
    expect(formatDuration(120_000)).toBe("2m"); // exactly 2 minutes, no stray "0s"
    expect(formatDuration(7_200_000)).toBe("2h 0m"); // exactly 2 hours
    expect(formatDuration(3_660_000)).toBe("1h 1m"); // 1h 1m 0s → seconds dropped
  });
});
