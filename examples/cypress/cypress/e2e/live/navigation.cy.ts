/**
 * Navigation and page transitions — extended tests for live demo.
 * Covers navigating between app sections with deliberate pauses.
 */
describe("Navigation (Live Demo)", () => {
  it("should navigate through all pages", () => {
    cy.visit("/#login");
    cy.wait(600);
    cy.get('[data-testid="login-form"]').should("be.visible");

    cy.visit("/#todos");
    cy.wait(600);
    cy.get('[data-testid="todo-input"]').should("be.visible");

    cy.visit("/#users");
    cy.wait(600);
    cy.get('[data-testid="users-table"]').should("be.visible");

    cy.visit("/#form");
    cy.wait(600);
    cy.get('[data-testid="contact-form"]').should("be.visible");
  });

  it("should use nav links to switch pages", () => {
    cy.visit("/#login");
    cy.wait(400);

    cy.get('nav a[href="#todos"]').click();
    cy.wait(500);
    cy.get('[data-testid="todo-input"]').should("be.visible");

    cy.get('nav a[href="#users"]').click();
    cy.wait(500);
    cy.get('[data-testid="users-table"]').should("be.visible");

    cy.get('nav a[href="#form"]').click();
    cy.wait(500);
    cy.get('[data-testid="contact-form"]').should("be.visible");

    cy.get('nav a[href="#login"]').click();
    cy.wait(500);
    cy.get('[data-testid="login-form"]').should("be.visible");
  });

  it("should highlight the active nav link", () => {
    cy.visit("/#todos");
    cy.wait(400);
    cy.get('nav a[href="#todos"]').should("have.class", "active");
    cy.wait(300);
    cy.get('nav a[href="#login"]').should("not.have.class", "active");
  });

  it("should show the app logo in the nav bar", () => {
    cy.visit("/#login");
    cy.wait(300);
    cy.get("nav .logo").should("be.visible").and("contain", "TestApp");
  });

  it("should maintain page state after navigation", () => {
    // Add a todo
    cy.visit("/#todos");
    cy.wait(300);
    cy.get('[data-testid="todo-input"]').type("Persistent item{enter}");
    cy.wait(300);
    cy.get('[data-testid="todo-list"]').should("contain", "Persistent item");

    // Navigate away and back
    cy.get('nav a[href="#login"]').click();
    cy.wait(500);
    cy.get('[data-testid="login-form"]').should("be.visible");

    cy.get('nav a[href="#todos"]').click();
    cy.wait(500);
    cy.get('[data-testid="todo-list"]').should("contain", "Persistent item");
  });
});
