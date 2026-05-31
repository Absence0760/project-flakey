import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo, absoluteDate, formatDuration } from "./format.js";

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
});

describe("absoluteDate", () => {
  it("returns '' for falsy or unparseable input", () => {
    expect(absoluteDate(null)).toBe("");
    expect(absoluteDate("")).toBe("");
    expect(absoluteDate("not-a-date")).toBe("");
  });

  it("includes the year for a valid timestamp", () => {
    expect(absoluteDate("2026-05-31T12:00:00Z")).toContain("2026");
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
});
