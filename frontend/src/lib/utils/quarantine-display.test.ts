import { describe, it, expect } from "vitest";
import { quarantineDisplay } from "./quarantine-display";

const NOW = new Date("2026-06-21T12:00:00Z");
function inDays(n: number): string {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000).toISOString();
}

describe("quarantineDisplay", () => {
  it("treats null / empty / unparseable expiry as indefinite (no expiry)", () => {
    for (const v of [null, undefined, "", "not-a-date"]) {
      const d = quarantineDisplay(v as string | null | undefined, NOW);
      expect(d.state).toBe("none");
      expect(d.daysRemaining).toBeNull();
      expect(d.expiringSoon).toBe(false);
      expect(d.label).toBe("Muted, no expiry");
    }
  });

  it("marks a past expiry as expired", () => {
    const d = quarantineDisplay(inDays(-1), NOW);
    expect(d.state).toBe("expired");
    expect(d.daysRemaining).toBe(0);
    expect(d.label).toBe("Muted — expired");
    expect(d.expiringSoon).toBe(false);
  });

  it("treats the exact expiry instant as expired", () => {
    const d = quarantineDisplay(NOW.toISOString(), NOW);
    expect(d.state).toBe("expired");
  });

  it("ceils remaining days so a sub-day future expiry reads as 1 day, not 0", () => {
    const halfDay = new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const d = quarantineDisplay(halfDay, NOW);
    expect(d.state).toBe("active");
    expect(d.daysRemaining).toBe(1);
    expect(d.label).toBe("Muted, expiring in 1 day");
  });

  it("renders N>1 days with a plural label", () => {
    const d = quarantineDisplay(inDays(10), NOW);
    expect(d.state).toBe("active");
    expect(d.daysRemaining).toBe(10);
    expect(d.label).toBe("Muted, expiring in 10 days");
  });

  it("flags expiringSoon inside the window and not outside it", () => {
    expect(quarantineDisplay(inDays(2), NOW, 3).expiringSoon).toBe(true);
    expect(quarantineDisplay(inDays(3), NOW, 3).expiringSoon).toBe(true);
    expect(quarantineDisplay(inDays(4), NOW, 3).expiringSoon).toBe(false);
  });
});
