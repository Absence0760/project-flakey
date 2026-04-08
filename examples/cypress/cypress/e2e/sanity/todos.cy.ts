describe("Todos", () => {
  beforeEach(() => {
    cy.visit("/#todos");
  });

  it("should add a new todo", () => {
    cy.get('[data-testid="todo-input"]').type("Buy groceries");
    cy.get('[data-testid="add-todo"]').click();
    cy.get('[data-testid="todo-list"]').should("contain", "Buy groceries");
  });

  it("should add a todo with Enter key", () => {
    cy.get('[data-testid="todo-input"]').type("Walk the dog{enter}");
    cy.get('[data-testid="todo-list"]').should("contain", "Walk the dog");
  });

  it("should mark a todo as completed", () => {
    cy.get('[data-testid="todo-input"]').type("Read a book{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').first().click();
    cy.get(".todo-item.done").should("exist");
  });

  it("should delete a todo", () => {
    cy.get('[data-testid="todo-input"]').type("Temporary{enter}");
    cy.get(".delete-btn").first().click();
    cy.get('[data-testid="todo-list"]').should("not.contain", "Temporary");
  });

  it("should filter active todos", () => {
    cy.get('[data-testid="todo-input"]').type("Active{enter}");
    cy.get('[data-testid="todo-input"]').type("Done{enter}");
    cy.get('[data-testid="todo-list"]').find('input[type="checkbox"]').last().click();
    cy.get('[data-testid="filter-active"]').click();
    cy.get(".todo-item").should("have.length", 1);
  });
});
