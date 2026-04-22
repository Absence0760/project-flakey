/**
 * INTENTIONALLY FLAKY TESTS
 *
 * These tests randomly fail ~30 % of the time to exercise the flaky-detection
 * feature of Better Testing.  The dashboard should surface them as "flaky" once
 * enough run history accumulates.
 *
 * Run in isolation:  pnpm test:flaky
 *
 * DO NOT include this folder in the smoke / sanity / regression / all suites.
 * It is excluded by the specPatterns map in cypress.config.ts.
 */

describe("Flaky tests (intentional)", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("flaky: random 30 % failure — page title", () => {
    // Randomly throw ~30 % of the time to simulate a flaky test.
    if (Math.random() < 0.3) {
      throw new Error(
        "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
      );
    }
    cy.title().should("not.be.empty");
  });

  it("flaky: random 30 % failure — nav visible", () => {
    if (Math.random() < 0.3) {
      throw new Error(
        "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
      );
    }
    cy.get("nav").should("be.visible");
  });

  it("flaky: random 30 % failure — body rendered", () => {
    if (Math.random() < 0.3) {
      throw new Error(
        "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
      );
    }
    cy.get("body").should("exist");
  });
});
