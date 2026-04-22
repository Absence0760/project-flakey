/**
 * Intentionally flaky test — fails roughly 30% of the time.
 *
 * This file lives in __tests__/flaky/ and is excluded from the default jest run
 * (see testPathIgnorePatterns in jest.config.ts). Run it explicitly with:
 *
 *   pnpm test:flaky
 *
 * It exists to demonstrate Better Testing's flaky detection: run it several
 * times and you'll see alternating PASS/FAIL results appear in the dashboard
 * with a flaky indicator once the flip rate exceeds the threshold.
 *
 * DO NOT fix this test — the non-determinism is intentional.
 */

describe("timing — flaky (intentional)", () => {
  it("passes ~70% of the time based on random chance", () => {
    // Seed with current second so the result is stable within a run
    // but varies between runs (which is the whole point).
    const roll = Math.random();
    // ~30% failure rate
    if (roll < 0.3) {
      throw new Error(
        `Intentional flaky failure (roll=${roll.toFixed(3)}). ` +
          "This test is expected to fail sometimes — that's the point."
      );
    }
    expect(roll).toBeGreaterThanOrEqual(0.3);
  });

  it("measures a trivial operation within a generous bound", () => {
    // Occasionally a slow CI machine will push this past 50 ms.
    const start = Date.now();
    const sum = Array.from({ length: 10_000 }, (_, i) => i).reduce((a, b) => a + b, 0);
    const elapsed = Date.now() - start;
    expect(sum).toBe(49_995_000);
    // 50 ms is intentionally tight — will flake on loaded machines ~30% of the time.
    expect(elapsed).toBeLessThan(50);
  });
});
