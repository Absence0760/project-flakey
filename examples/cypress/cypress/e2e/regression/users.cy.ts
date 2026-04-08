describe("Users Table", () => {
  beforeEach(() => {
    cy.visit("/#users");
  });

  it("should display all users", () => {
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 5);
  });

  it("should be sorted by name ascending by default", () => {
    cy.get('[data-testid="users-body"] tr').first().should("contain", "Alice Johnson");
    cy.get('[data-testid="users-body"] tr').last().should("contain", "Eve Davis");
  });

  it("should sort by name descending on click", () => {
    cy.get('[data-testid="sort-name"]').click();
    cy.get('[data-testid="users-body"] tr').first().should("contain", "Eve Davis");
    cy.get('[data-testid="users-body"] tr').last().should("contain", "Alice Johnson");
  });

  it("should sort by email", () => {
    cy.get('[data-testid="sort-email"]').click();
    cy.get('[data-testid="users-body"] tr').first().should("contain", "alice@test.com");
  });

  it("should sort by role", () => {
    cy.get('[data-testid="sort-role"]').click();
    cy.get('[data-testid="users-body"] tr').first().should("contain", "Admin");
  });

  it("should open delete confirmation modal", () => {
    cy.get('[data-testid="delete-alice@test.com"]').click();
    cy.get('[data-testid="delete-modal"]').should("be.visible");
    cy.get("#delete-user-name").should("contain", "Alice Johnson");
  });

  it("should cancel delete", () => {
    cy.get('[data-testid="delete-alice@test.com"]').click();
    cy.get('[data-testid="cancel-delete"]').click();
    cy.get('[data-testid="delete-modal"]').should("not.be.visible");
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 5);
  });

  it("should confirm delete and remove user", () => {
    cy.get('[data-testid="delete-bob@test.com"]').click();
    cy.get('[data-testid="confirm-delete"]').click();
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 4);
    cy.get('[data-testid="users-body"]').should("not.contain", "Bob Smith");
  });
});
