import { Given, When, Then } from "@badeball/cypress-cucumber-preprocessor";

Given("I visit the login page", () => {
  cy.visit("/#login");
});

When("I enter {string} as the email", (email: string) => {
  cy.get('[data-testid="email-input"]').type(email);
});

When("I enter {string} as the password", (password: string) => {
  cy.get('[data-testid="password-input"]').type(password);
});

When("I click the login button", () => {
  cy.get('[data-testid="login-button"]').click();
});

Then("I should see the login form", () => {
  cy.get('[data-testid="login-form"]').should("be.visible");
});

Then("I should see the email input", () => {
  cy.get('[data-testid="email-input"]').should("be.visible");
});

Then("I should see the password input", () => {
  cy.get('[data-testid="password-input"]').should("be.visible");
});

Then("I should see the login button", () => {
  cy.get('[data-testid="login-button"]').should("be.visible");
});

Then("I should see the login success message", () => {
  cy.get('[data-testid="login-success"]').should("be.visible");
});

Then("I should see the todos page", () => {
  cy.get('[data-testid="todos-page"]').should("be.visible");
});

Then("I should see the login error message", () => {
  cy.get('[data-testid="login-error"]').should("be.visible");
});

Then("I should not see the login success message", () => {
  cy.get('[data-testid="login-success"]').should("not.be.visible");
});

Then("I should not see the login error message", () => {
  cy.get('[data-testid="login-error"]').should("not.be.visible");
});
