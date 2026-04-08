/**
 * Login flow — extended tests to demonstrate live reporting.
 * Each test includes deliberate waits so you can watch events
 * stream into the Flakey dashboard in real-time.
 */
describe("Login Flow (Live Demo)", () => {
  beforeEach(() => {
    cy.visit("/#login");
    cy.wait(500);
  });

  it("should render the login page with all form elements", () => {
    cy.get('[data-testid="login-form"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="email-input"]').should("be.visible").and("have.attr", "type", "text");
    cy.wait(300);
    cy.get('[data-testid="password-input"]').should("be.visible").and("have.attr", "type", "password");
    cy.wait(300);
    cy.get('[data-testid="login-button"]').should("be.visible").and("contain", "Sign In");
  });

  it("should focus the email field on page load", () => {
    cy.wait(500);
    cy.get('[data-testid="email-input"]').click();
    cy.wait(200);
    cy.focused().should("have.attr", "data-testid", "email-input");
  });

  it("should type into email and password fields", () => {
    cy.get('[data-testid="email-input"]').type("user@example.com");
    cy.wait(400);
    cy.get('[data-testid="email-input"]').should("have.value", "user@example.com");
    cy.wait(300);
    cy.get('[data-testid="password-input"]').type("secretpassword");
    cy.wait(400);
    cy.get('[data-testid="password-input"]').should("have.value", "secretpassword");
  });

  it("should successfully login with valid credentials", () => {
    cy.get('[data-testid="email-input"]').type("admin@test.com");
    cy.wait(300);
    cy.get('[data-testid="password-input"]').type("password");
    cy.wait(300);
    cy.get('[data-testid="login-button"]').click();
    cy.wait(500);
    cy.get('[data-testid="login-success"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="todos-page"]').should("be.visible");
  });

  it("should display an error for invalid credentials", () => {
    cy.get('[data-testid="email-input"]').type("hacker@evil.com");
    cy.wait(200);
    cy.get('[data-testid="password-input"]').type("wrongpassword");
    cy.wait(200);
    cy.get('[data-testid="login-button"]').click();
    cy.wait(500);
    cy.get('[data-testid="login-error"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="login-success"]').should("not.be.visible");
  });

  it("should clear error state when retrying login", () => {
    // First attempt — fail
    cy.get('[data-testid="email-input"]').type("bad@test.com");
    cy.get('[data-testid="password-input"]').type("nope");
    cy.get('[data-testid="login-button"]').click();
    cy.wait(400);
    cy.get('[data-testid="login-error"]').should("be.visible");

    // Clear and retry
    cy.get('[data-testid="email-input"]').clear().type("admin@test.com");
    cy.wait(300);
    cy.get('[data-testid="password-input"]').clear().type("password");
    cy.wait(300);
    cy.get('[data-testid="login-button"]').click();
    cy.wait(500);
    cy.get('[data-testid="login-success"]').should("be.visible");
  });
});
