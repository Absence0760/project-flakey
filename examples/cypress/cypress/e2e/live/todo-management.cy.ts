/**
 * Todo management — extended tests to demonstrate live reporting.
 * Tests are deliberately spaced out so events appear one by one
 * in the Flakey live view.
 */
describe("Todo Management (Live Demo)", () => {
  beforeEach(() => {
    cy.visit("/#todos");
    cy.wait(500);
  });

  it("should render an empty todo list", () => {
    cy.get('[data-testid="todo-list"]').should("be.visible");
    cy.wait(400);
    cy.get('[data-testid="todo-input"]').should("be.visible");
    cy.wait(300);
    cy.get('[data-testid="add-todo"]').should("be.visible");
  });

  it("should add a single todo item", () => {
    cy.get('[data-testid="todo-input"]').type("Buy groceries");
    cy.wait(300);
    cy.get('[data-testid="add-todo"]').click();
    cy.wait(400);
    cy.get('[data-testid="todo-list"]').should("contain", "Buy groceries");
    cy.wait(200);
    cy.get('[data-testid="todo-count"]').should("contain", "1 item");
  });

  it("should add multiple todo items sequentially", () => {
    const items = ["Morning run", "Team standup", "Code review", "Lunch break", "Deploy v2.1"];

    for (const item of items) {
      cy.get('[data-testid="todo-input"]').type(`${item}{enter}`);
      cy.wait(400);
      cy.get('[data-testid="todo-list"]').should("contain", item);
    }

    cy.wait(300);
    cy.get(".todo-item").should("have.length", items.length);
  });

  it("should mark todos as completed one by one", () => {
    // Add items
    cy.get('[data-testid="todo-input"]').type("Task A{enter}");
    cy.wait(200);
    cy.get('[data-testid="todo-input"]').type("Task B{enter}");
    cy.wait(200);
    cy.get('[data-testid="todo-input"]').type("Task C{enter}");
    cy.wait(400);

    // Complete them one by one
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').eq(0).click();
    cy.wait(500);
    cy.get(".todo-item.done").should("have.length", 1);

    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').eq(1).click();
    cy.wait(500);
    cy.get(".todo-item.done").should("have.length", 2);

    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').eq(2).click();
    cy.wait(500);
    cy.get(".todo-item.done").should("have.length", 3);
    cy.get('[data-testid="todo-count"]').should("contain", "0 items");
  });

  it("should delete a todo and verify the list updates", () => {
    cy.get('[data-testid="todo-input"]').type("Will be deleted{enter}");
    cy.wait(300);
    cy.get('[data-testid="todo-input"]').type("Will stay{enter}");
    cy.wait(300);

    cy.get(".todo-item").should("have.length", 2);
    cy.wait(200);

    cy.get(".delete-btn").first().click();
    cy.wait(400);
    cy.get(".todo-item").should("have.length", 1);
    cy.get('[data-testid="todo-list"]').should("contain", "Will stay");
    cy.get('[data-testid="todo-list"]').should("not.contain", "Will be deleted");
  });

  it("should filter between all, active, and completed", () => {
    // Set up data
    cy.get('[data-testid="todo-input"]').type("Active item{enter}");
    cy.wait(200);
    cy.get('[data-testid="todo-input"]').type("Completed item{enter}");
    cy.wait(200);
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').last().click();
    cy.wait(400);

    // Filter active
    cy.get('[data-testid="filter-active"]').click();
    cy.wait(400);
    cy.get(".todo-item").should("have.length", 1);
    cy.get('[data-testid="todo-list"]').should("contain", "Active item");

    // Filter completed
    cy.get('[data-testid="filter-completed"]').click();
    cy.wait(400);
    cy.get(".todo-item").should("have.length", 1);
    cy.get(".todo-item.done").should("exist");

    // Show all
    cy.get('[data-testid="filter-all"]').click();
    cy.wait(400);
    cy.get(".todo-item").should("have.length", 2);
  });

  it("should handle rapid todo additions", () => {
    for (let i = 1; i <= 8; i++) {
      cy.get('[data-testid="todo-input"]').type(`Item #${i}{enter}`);
      cy.wait(250);
    }
    cy.wait(300);
    cy.get(".todo-item").should("have.length", 8);
    cy.get('[data-testid="todo-count"]').should("contain", "8 items");
  });
});
