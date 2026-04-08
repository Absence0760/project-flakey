/**
 * Form validation — extended tests for live demo.
 * Tests the contact form with various input scenarios.
 */
describe("Form Validation (Live Demo)", () => {
  beforeEach(() => {
    cy.visit("/#form");
    cy.wait(500);
  });

  it("should render the contact form with all fields", () => {
    cy.get('[data-testid="contact-form"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="name-input"]').should("be.visible");
    cy.wait(200);
    cy.get('[data-testid="email-input"]').should("be.visible");
    cy.wait(200);
    cy.get('[data-testid="message-input"]').should("be.visible");
    cy.wait(200);
    cy.get('[data-testid="submit-btn"]').should("be.visible");
  });

  it("should fill out the form completely", () => {
    cy.get('[data-testid="name-input"]').type("Jane Smith");
    cy.wait(300);
    cy.get('[data-testid="email-input"]').type("jane@company.com");
    cy.wait(300);
    cy.get('[data-testid="message-input"]').type("Hello, I would like to learn more about your testing platform. Can you schedule a demo for our team next week?");
    cy.wait(400);
    cy.get('[data-testid="name-input"]').should("have.value", "Jane Smith");
    cy.get('[data-testid="email-input"]').should("have.value", "jane@company.com");
  });

  it("should submit the form successfully", () => {
    cy.get('[data-testid="name-input"]').type("Test User");
    cy.wait(200);
    cy.get('[data-testid="email-input"]').type("test@test.com");
    cy.wait(200);
    cy.get('[data-testid="message-input"]').type("This is a test submission.");
    cy.wait(300);
    cy.get('[data-testid="submit-btn"]').click();
    cy.wait(500);
    cy.get('[data-testid="form-success"]').should("be.visible");
  });

  it("should clear form fields after submission", () => {
    cy.get('[data-testid="name-input"]').type("Clear Test");
    cy.get('[data-testid="email-input"]').type("clear@test.com");
    cy.get('[data-testid="message-input"]').type("Should be cleared after submit.");
    cy.wait(300);
    cy.get('[data-testid="submit-btn"]').click();
    cy.wait(500);
    cy.get('[data-testid="form-success"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="name-input"]').should("have.value", "");
    cy.get('[data-testid="email-input"]').should("have.value", "");
    cy.get('[data-testid="message-input"]').should("have.value", "");
  });

  it("should handle long form input gracefully", () => {
    const longName = "A".repeat(100);
    const longMessage = "Testing long input. ".repeat(20);

    cy.get('[data-testid="name-input"]').type(longName);
    cy.wait(300);
    cy.get('[data-testid="email-input"]').type("long@input.com");
    cy.wait(300);
    cy.get('[data-testid="message-input"]').type(longMessage);
    cy.wait(400);
    cy.get('[data-testid="submit-btn"]').click();
    cy.wait(500);
    cy.get('[data-testid="form-success"]').should("be.visible");
  });
});
