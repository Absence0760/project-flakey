describe("Form", () => {
  beforeEach(() => {
    cy.visit("/#form");
  });

  it("should display the form with default values", () => {
    cy.get('[data-testid="create-form"]').should("be.visible");
    cy.get('[data-testid="item-priority"]').should("have.value", "medium");
  });

  it("should submit with all fields", () => {
    cy.get('[data-testid="item-name"]').type("New feature");
    cy.get('[data-testid="item-category"]').select("feature");
    cy.get('[data-testid="item-priority"]').select("high");
    cy.get('[data-testid="item-description"]').type("A great feature");
    cy.get('[data-testid="item-urgent"]').check();
    cy.get('[data-testid="submit-form"]').click();
    cy.get('[data-testid="form-result"]').should("be.visible").and("contain", "New feature");
  });

  it("should submit with only required fields", () => {
    cy.get('[data-testid="item-name"]').type("Minimal");
    cy.get('[data-testid="submit-form"]').click();
    cy.get('[data-testid="form-result"]').should("contain", "Minimal");
  });

  it("should reset the form", () => {
    cy.get('[data-testid="item-name"]').type("Something");
    cy.get('[data-testid="item-urgent"]').check();
    cy.get('[data-testid="reset-form"]').click();
    cy.get('[data-testid="item-name"]').should("have.value", "");
    cy.get('[data-testid="item-urgent"]').should("not.be.checked");
  });
});
