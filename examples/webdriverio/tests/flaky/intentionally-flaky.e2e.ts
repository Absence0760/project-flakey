/**
 * Intentionally flaky tests.
 *
 * These tests fail randomly ~30% of the time to exercise the Better Testing
 * flaky-detection feature.  They must never be included in smoke/sanity/regression
 * spec patterns — they have their own `test:flaky` script.
 *
 * DO NOT add these to the standard SUITE spec patterns in wdio.conf.ts.
 */

describe("Intentionally flaky — network timing", () => {
  it("should sometimes fail due to timing variance", async () => {
    await browser.url("/#todos");
    await browser.pause(100);

    // Simulate a flaky condition: ~30% random failure
    const roll = Math.random();
    if (roll < 0.3) {
      throw new Error(
        `Flaky failure triggered (roll=${roll.toFixed(3)}). ` +
        "This is intentional — used to demonstrate flaky-detection.",
      );
    }

    const input = await $('[data-testid="todo-input"]');
    await expect(input).toBeDisplayed();
  });
});

describe("Intentionally flaky — race condition simulation", () => {
  it("should sometimes fail as if an element is not yet rendered", async () => {
    await browser.url("/#todos");

    // Intentionally do NOT wait — simulates a race where the SPA hasn't
    // rendered the element yet.
    const roll = Math.random();
    if (roll < 0.3) {
      throw new Error(
        `Flaky race condition triggered (roll=${roll.toFixed(3)}). ` +
        "This is intentional — used to demonstrate flaky-detection.",
      );
    }

    const list = await $('[data-testid="todo-list"]');
    await expect(list).toExist();
  });
});

describe("Intentionally flaky — stale element simulation", () => {
  it("should sometimes fail as if a DOM node was replaced", async () => {
    await browser.url("/#todos");
    await browser.pause(150);

    const roll = Math.random();
    if (roll < 0.3) {
      throw new Error(
        `Flaky stale-element triggered (roll=${roll.toFixed(3)}). ` +
        "This is intentional — used to demonstrate flaky-detection.",
      );
    }

    await $('[data-testid="todo-input"]').setValue("Flaky item");
    await $('[data-testid="add-todo"]').click();
    const list = await $('[data-testid="todo-list"]');
    await expect(list).toHaveText(expect.stringContaining("Flaky item"));
  });
});
