/**
 * INTENTIONALLY FLAKY step definitions
 *
 * These steps randomly fail ~30 % of the time to exercise the
 * flaky-detection feature of Better Testing.  Run via `pnpm test:flaky`.
 * DO NOT add this file's steps to any smoke/sanity/regression suite.
 */

import { Given, Then } from "@badeball/cypress-cucumber-preprocessor";

Given("the app is loaded", () => {
  cy.visit("/");
});

Then("the page title flakily passes", () => {
  if (Math.random() < 0.3) {
    throw new Error(
      "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
    );
  }
  cy.title().should("not.be.empty");
});

Then("the nav flakily passes", () => {
  if (Math.random() < 0.3) {
    throw new Error(
      "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
    );
  }
  cy.get("nav").should("be.visible");
});

Then("the body flakily passes", () => {
  if (Math.random() < 0.3) {
    throw new Error(
      "[intentional flaky failure] simulated intermittent error for flaky-detection demo",
    );
  }
  cy.get("body").should("exist");
});
