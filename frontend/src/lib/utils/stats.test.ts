import { describe, it, expect } from "vitest";
import { passRate } from "./stats.js";

describe("passRate", () => {
  it("rounds to a whole percentage", () => {
    expect(passRate({ total: 3, passed: 2 })).toBe(67);
    expect(passRate({ total: 8, passed: 1 })).toBe(13);
  });

  it("is 0 for an empty run (no divide-by-zero)", () => {
    expect(passRate({ total: 0, passed: 0 })).toBe(0);
  });

  it("is 100 when all pass", () => {
    expect(passRate({ total: 5, passed: 5 })).toBe(100);
  });

  it("does not clamp impossible (passed > total) data — surfaces it rather than hiding it", () => {
    // Shouldn't occur (the API never reports more passes than tests), but
    // pin the contract: no silent clamp to 100.
    expect(passRate({ total: 3, passed: 5 })).toBe(167);
  });
});
