describe("Todos", () => {
  beforeEach(() => {
    cy.visit("/#todos");
  });

  it("should add a new todo", () => {
    cy.get('[data-testid="todo-input"]').type("Buy groceries");
    cy.get('[data-testid="add-todo"]').click();
    cy.get('[data-testid="todo-list"]').should("contain", "Buy groceries");
    cy.get('[data-testid="todo-count"]').should("contain", "1 item");
  });

  it("should add a todo with Enter key", () => {
    cy.get('[data-testid="todo-input"]').type("Walk the dog{enter}");
    cy.get('[data-testid="todo-list"]').should("contain", "Walk the dog");
  });

  it("should mark a todo as completed", () => {
    cy.get('[data-testid="todo-input"]').type("Read a book{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').first().click();
    cy.get(".todo-item.done").should("exist");
    cy.get('[data-testid="todo-count"]').should("contain", "0 items");
  });

  it("should delete a todo", () => {
    cy.get('[data-testid="todo-input"]').type("Temporary item{enter}");
    cy.get('[data-testid="todo-list"]').should("contain", "Temporary item");
    cy.get(".delete-btn").first().click();
    cy.get('[data-testid="todo-list"]').should("not.contain", "Temporary item");
  });

  it("should filter active todos", () => {
    cy.get('[data-testid="todo-input"]').type("Active task{enter}");
    cy.get('[data-testid="todo-input"]').type("Done task{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').last().click();
    cy.get('[data-testid="filter-active"]').click();
    cy.get(".todo-item").should("have.length", 1);
    cy.get('[data-testid="todo-list"]').should("contain", "Active task");
  });

  it("should filter completed todos", () => {
    cy.get('[data-testid="todo-input"]').type("Task A{enter}");
    cy.get('[data-testid="todo-input"]').type("Task B{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').first().click();
    cy.get('[data-testid="filter-completed"]').click();
    cy.get(".todo-item").should("have.length", 1);
    cy.get(".todo-item.done").should("exist");
  });

  it("should show all todos with All filter", () => {
    cy.get('[data-testid="todo-input"]').type("Item 1{enter}");
    cy.get('[data-testid="todo-input"]').type("Item 2{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').first().click();
    cy.get('[data-testid="filter-completed"]').click();
    cy.get('[data-testid="filter-all"]').click();
    cy.get(".todo-item").should("have.length", 2);
  });
});
