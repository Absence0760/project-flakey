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

  it("should fail - login then wrong assertion", () => {
    cy.get('[data-testid="email-input"]').type("admin@test.com");
    cy.get('[data-testid="password-input"]').type("password");
    cy.get('[data-testid="login-button"]').click();
    cy.get('[data-testid="login-success"]').should("be.visible");
    cy.get('[data-testid="todos-page"]').should("be.visible");
    cy.get('[data-testid="todo-input"]').type("Buy milk{enter}");
    cy.get('[data-testid="todo-list"]').should("contain", "Buy milk");
    cy.get('[data-testid="todo-count"]').should("contain", "1 item");
    // This assertion will fail
    cy.get('[data-testid="todo-count"]').should("contain", "99 items");
  });
});
