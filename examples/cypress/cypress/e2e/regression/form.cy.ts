describe("Form", () => {
  beforeEach(() => {
    cy.visit("/#form");
  });

  it("should display the form", () => {
    cy.get('[data-testid="create-form"]').should("be.visible");
    cy.get('[data-testid="item-name"]').should("be.visible");
    cy.get('[data-testid="item-category"]').should("be.visible");
    cy.get('[data-testid="item-priority"]').should("have.value", "medium");
  });

  it("should submit the form and show result", () => {
    cy.get('[data-testid="item-name"]').type("Fix login bug");
    cy.get('[data-testid="item-category"]').select("bug");
    cy.get('[data-testid="item-priority"]').select("high");
    cy.get('[data-testid="item-description"]').type("Login fails on Safari");
    cy.get('[data-testid="item-urgent"]').check();
    cy.get('[data-testid="submit-form"]').click();
    cy.get('[data-testid="form-result"]').should("be.visible");
    cy.get('[data-testid="form-result"]').should("contain", "Fix login bug");
    cy.get('[data-testid="form-result"]').should("contain", "bug");
    cy.get('[data-testid="form-result"]').should("contain", "high");
    cy.get('[data-testid="form-result"]').should("contain", "URGENT");
  });

  it("should reset the form", () => {
    cy.get('[data-testid="item-name"]').type("Something");
    cy.get('[data-testid="item-category"]').select("feature");
    cy.get('[data-testid="item-urgent"]').check();
    cy.get('[data-testid="reset-form"]').click();
    cy.get('[data-testid="item-name"]').should("have.value", "");
    cy.get('[data-testid="item-category"]').should("have.value", "");
    cy.get('[data-testid="item-urgent"]').should("not.be.checked");
  });

  it("should require the name field", () => {
    cy.get('[data-testid="submit-form"]').click();
    cy.get('[data-testid="form-result"]').should("not.be.visible");
  });

  it("should submit without optional fields", () => {
    cy.get('[data-testid="item-name"]').type("Minimal item");
    cy.get('[data-testid="submit-form"]').click();
    cy.get('[data-testid="form-result"]').should("be.visible");
    cy.get('[data-testid="form-result"]').should("contain", "Minimal item");
    cy.get('[data-testid="form-result"]').should("contain", "uncategorized");
  });
});
