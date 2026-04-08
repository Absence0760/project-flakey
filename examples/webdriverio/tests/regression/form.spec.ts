describe("Form", () => {
  beforeEach(async () => {
    await browser.url("/#form");
  });

  it("should display the form with default values", async () => {
    const form = await $('[data-testid="create-form"]');
    await expect(form).toBeDisplayed();
    const priority = await $('[data-testid="item-priority"]');
    await expect(priority).toHaveValue("medium");
  });

  it("should submit with all fields", async () => {
    await $('[data-testid="item-name"]').setValue("New feature");
    await $('[data-testid="item-category"]').selectByAttribute("value", "feature");
    await $('[data-testid="item-priority"]').selectByAttribute("value", "high");
    await $('[data-testid="item-description"]').setValue("A great feature");
    await $('[data-testid="item-urgent"]').click();
    await $('[data-testid="submit-form"]').click();
    const result = await $('[data-testid="form-result"]');
    await expect(result).toBeDisplayed();
    await expect(result).toHaveText(expect.stringContaining("New feature"));
  });

  it("should reset the form", async () => {
    await $('[data-testid="item-name"]').setValue("Something");
    await $('[data-testid="item-urgent"]').click();
    await $('[data-testid="reset-form"]').click();
    const name = await $('[data-testid="item-name"]');
    await expect(name).toHaveValue("");
  });
});
