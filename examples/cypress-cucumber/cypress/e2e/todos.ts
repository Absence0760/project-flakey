import { Given, When, Then } from "@badeball/cypress-cucumber-preprocessor";

Given("I visit the todos page", () => {
  cy.visit("/#todos");
});

When("I type {string} in the todo input", (text: string) => {
  cy.get('[data-testid="todo-input"]').type(text);
});

When("I type {string} in the todo input and press enter", (text: string) => {
  cy.get('[data-testid="todo-input"]').type(`${text}{enter}`);
});

When("I click the add todo button", () => {
  cy.get('[data-testid="add-todo"]').click();
});

When("I check the first todo", () => {
  cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').first().click();
});

When("I check the last todo", () => {
  cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').last().click();
});

When("I delete the first todo", () => {
  cy.get(".delete-btn").first().click();
});

When("I click the active filter", () => {
  cy.get('[data-testid="filter-active"]').click();
});

When("I click the completed filter", () => {
  cy.get('[data-testid="filter-completed"]').click();
});

Then("the todo list should contain {string}", (text: string) => {
  cy.get('[data-testid="todo-list"]').should("contain", text);
});

Then("the todo list should not contain {string}", (text: string) => {
  cy.get('[data-testid="todo-list"]').should("not.contain", text);
});

Then("the todo count should show {string}", (count: string) => {
  cy.get('[data-testid="todo-count"]').should("contain", count);
});

Then("the first todo should be marked as done", () => {
  cy.get(".todo-item.done").should("exist");
});

Then("there should be {int} todo visible", (count: number) => {
  cy.get(".todo-item").should("have.length", count);
});
