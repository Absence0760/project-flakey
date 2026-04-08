describe("Users Table", () => {
  beforeEach(async () => {
    await browser.url("/#users");
  });

  it("should display all users", async () => {
    const rows = await $$('[data-testid="users-body"] tr');
    expect(rows.length).toBe(5);
  });

  it("should be sorted by name ascending by default", async () => {
    const firstRow = await $('[data-testid="users-body"] tr:first-child');
    await expect(firstRow).toHaveText(expect.stringContaining("Alice Johnson"));
  });

  it("should sort by name descending on click", async () => {
    await $('[data-testid="sort-name"]').click();
    const firstRow = await $('[data-testid="users-body"] tr:first-child');
    await expect(firstRow).toHaveText(expect.stringContaining("Eve Davis"));
  });

  it("should open and cancel delete modal", async () => {
    await $('[data-testid="delete-alice@test.com"]').click();
    const modal = await $('[data-testid="delete-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });
    await $('[data-testid="cancel-delete"]').click();
    const rows = await $$('[data-testid="users-body"] tr');
    expect(rows.length).toBe(5);
  });

  it("should delete a user", async () => {
    await $('[data-testid="delete-bob@test.com"]').click();
    const modal = await $('[data-testid="delete-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });
    await $('[data-testid="confirm-delete"]').click();
    await browser.pause(500);
    const rows = await $$('[data-testid="users-body"] tr');
    expect(rows.length).toBe(4);
  });
});
