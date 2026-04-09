import { Given, When, Then } from "@badeball/cypress-cucumber-preprocessor";

Given("I visit the users page", () => {
  cy.visit("/#users");
});

When("I click the name sort header", () => {
  cy.get('[data-testid="sort-name"]').click();
});

When("I click delete for {string}", (email: string) => {
  cy.get(`[data-testid="delete-${email}"]`).click();
});

When("I cancel the delete", () => {
  cy.get('[data-testid="cancel-delete"]').click();
});

When("I confirm the delete", () => {
  cy.get('[data-testid="confirm-delete"]').click();
});

Then("I should see {int} users in the table", (count: number) => {
  cy.get('[data-testid="users-body"]').find("tr").should("have.length", count);
});

Then("the first user should be {string}", (name: string) => {
  cy.get('[data-testid="users-body"] tr').first().should("contain", name);
});

Then("the delete modal should be visible", () => {
  cy.get('[data-testid="delete-modal"]').should("be.visible");
});

Then("the delete modal should not be visible", () => {
  cy.get('[data-testid="delete-modal"]').should("not.be.visible");
});
