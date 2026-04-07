describe("Intentional Failures", () => {
  beforeEach(() => {
    cy.visit("/#login");
  });

  it("should fail - element does not exist", () => {
    cy.get('[data-testid="nonexistent-button"]').should("be.visible");
  });

  it("should fail - wrong text content", () => {
    cy.get('[data-testid="login-button"]').should("contain", "Submit Form");
  });

  it("should fail - timeout waiting for element", () => {
    cy.get('[data-testid="login-button"]').click();
    cy.get('[data-testid="login-success"]', { timeout: 2000 }).should("be.visible");
  });
});
