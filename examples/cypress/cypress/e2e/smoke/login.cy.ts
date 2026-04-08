describe("Login", () => {
  beforeEach(() => {
    cy.visit("/#login");
  });

  it("should show the login form", () => {
    cy.get('[data-testid="login-form"]').should("be.visible");
    cy.get('[data-testid="email-input"]').should("be.visible");
    cy.get('[data-testid="password-input"]').should("be.visible");
    cy.get('[data-testid="login-button"]').should("be.visible");
  });

  it("should login with valid credentials", () => {
    cy.get('[data-testid="email-input"]').type("admin@test.com");
    cy.get('[data-testid="password-input"]').type("password");
    cy.get('[data-testid="login-button"]').click();
    cy.get('[data-testid="login-success"]').should("be.visible");
    cy.get('[data-testid="todos-page"]').should("be.visible");
  });

  it("should show error with invalid credentials", () => {
    cy.get('[data-testid="email-input"]').type("wrong@test.com");
    cy.get('[data-testid="password-input"]').type("wrong");
    cy.get('[data-testid="login-button"]').click();
    cy.get('[data-testid="login-error"]').should("be.visible");
  });

  it("should not show success message initially", () => {
    cy.get('[data-testid="login-success"]').should("not.be.visible");
    cy.get('[data-testid="login-error"]').should("not.be.visible");
  });
});
