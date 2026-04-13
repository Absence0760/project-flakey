import { Given, When, Then } from "@badeball/cypress-cucumber-preprocessor";

Given("I visit the form page", () => {
  cy.visit("/#form");
});

When("I enter {string} as the item name", (name: string) => {
  cy.get('[data-testid="item-name"]').type(name);
});

When("I select {string} as the category", (category: string) => {
  cy.get('[data-testid="item-category"]').select(category);
});

When("I select {string} as the priority", (priority: string) => {
  cy.get('[data-testid="item-priority"]').select(priority);
});

When("I enter {string} as the description", (description: string) => {
  cy.get('[data-testid="item-description"]').type(description);
});

When("I check the urgent checkbox", () => {
  cy.get('[data-testid="item-urgent"]').check();
});

When("I submit the form", () => {
  cy.get('[data-testid="submit-form"]').click();
});

When("I reset the form", () => {
  cy.get('[data-testid="reset-form"]').click();
});

Then("the form should be visible", () => {
  cy.get('[data-testid="create-form"]').should("be.visible");
});

Then("the priority should default to {string}", (value: string) => {
  cy.get('[data-testid="item-priority"]').should("have.value", value);
});

Then("the form result should be visible", () => {
  cy.get('[data-testid="form-result"]').should("be.visible");
});

Then("the form result should contain {string}", (text: string) => {
  cy.get('[data-testid="form-result"]').should("contain", text);
});

Then("the item name should be empty", () => {
  cy.get('[data-testid="item-name"]').should("have.value", "");
});

Then("the urgent checkbox should not be checked", () => {
  cy.get('[data-testid="item-urgent"]').should("not.be.checked");
});
