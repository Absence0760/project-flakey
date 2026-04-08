describe("Login", () => {
  beforeEach(async () => {
    await browser.url("/#login");
  });

  it("should show the login form", async () => {
    const form = await $('[data-testid="login-form"]');
    await expect(form).toBeDisplayed();
  });

  it("should login with valid credentials", async () => {
    await $('[data-testid="email-input"]').setValue("admin@test.com");
    await $('[data-testid="password-input"]').setValue("password");
    await $('[data-testid="login-button"]').click();
    const success = await $('[data-testid="login-success"]');
    await success.waitForDisplayed({ timeout: 5000 });
    await expect(success).toBeDisplayed();
  });

  it("should show error with invalid credentials", async () => {
    await $('[data-testid="email-input"]').setValue("wrong@test.com");
    await $('[data-testid="password-input"]').setValue("wrong");
    await $('[data-testid="login-button"]').click();
    const error = await $('[data-testid="login-error"]');
    await error.waitForDisplayed({ timeout: 5000 });
    await expect(error).toBeDisplayed();
  });
});
