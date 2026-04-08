describe("Intentional Failures", () => {
  beforeEach(async () => {
    await browser.url("/#login");
  });

  it("should fail - element does not exist", async () => {
    const el = await $('[data-testid="nonexistent-button"]');
    await expect(el).toBeDisplayed({ wait: 2000 });
  });

  it("should fail - wrong text content", async () => {
    const button = await $('[data-testid="login-button"]');
    await expect(button).toHaveText(expect.stringContaining("Submit Form"), { wait: 2000 });
  });

  it("should fail - login then wrong assertion", async () => {
    await $('[data-testid="email-input"]').setValue("admin@test.com");
    await $('[data-testid="password-input"]').setValue("password");
    await $('[data-testid="login-button"]').click();
    const success = await $('[data-testid="login-success"]');
    await success.waitForDisplayed({ timeout: 5000 });
    const todosPage = await $('[data-testid="todos-page"]');
    await todosPage.waitForDisplayed({ timeout: 5000 });
    const input = await $('[data-testid="todo-input"]');
    await input.setValue("Buy milk");
    await input.keys("Enter");
    const list = await $('[data-testid="todo-list"]');
    await expect(list).toHaveText(expect.stringContaining("Buy milk"));
    const count = await $('[data-testid="todo-count"]');
    await expect(count).toHaveText(expect.stringContaining("99 items"), { wait: 2000 });
  });
});
