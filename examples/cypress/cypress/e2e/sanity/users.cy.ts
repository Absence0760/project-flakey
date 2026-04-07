describe("Users Table", () => {
  beforeEach(() => {
    cy.visit("/#users");
  });

  it("should display all users", () => {
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 5);
  });

  it("should be sorted by name ascending by default", () => {
    cy.get('[data-testid="users-body"] tr').first().should("contain", "Alice Johnson");
  });

  it("should sort by name descending on click", () => {
    cy.get('[data-testid="sort-name"]').click();
    cy.get('[data-testid="users-body"] tr').first().should("contain", "Eve Davis");
  });

  it("should open and cancel delete modal", () => {
    cy.get('[data-testid="delete-alice@test.com"]').click();
    cy.get('[data-testid="delete-modal"]').should("be.visible");
    cy.get('[data-testid="cancel-delete"]').click();
    cy.get('[data-testid="delete-modal"]').should("not.be.visible");
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 5);
  });

  it("should delete a user", () => {
    cy.get('[data-testid="delete-bob@test.com"]').click();
    cy.get('[data-testid="confirm-delete"]').click();
    cy.get('[data-testid="users-body"]').find("tr").should("have.length", 4);
  });
});
