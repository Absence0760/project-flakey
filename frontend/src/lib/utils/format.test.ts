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
});
