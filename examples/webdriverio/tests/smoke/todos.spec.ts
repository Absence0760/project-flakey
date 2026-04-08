describe("Todos", () => {
  beforeEach(async () => {
    await browser.url("/#todos");
  });

  it("should add a new todo", async () => {
    await $('[data-testid="todo-input"]').setValue("Buy groceries");
    await $('[data-testid="add-todo"]').click();
    const list = await $('[data-testid="todo-list"]');
    await expect(list).toHaveText(expect.stringContaining("Buy groceries"));
  });

  it("should add a todo with Enter key", async () => {
    const input = await $('[data-testid="todo-input"]');
    await input.setValue("Walk the dog");
    await input.keys("Enter");
    const list = await $('[data-testid="todo-list"]');
    await expect(list).toHaveText(expect.stringContaining("Walk the dog"));
  });

  it("should mark a todo as completed", async () => {
    const input = await $('[data-testid="todo-input"]');
    await input.setValue("Read a book");
    await input.keys("Enter");
    const checkbox = await $('[data-testid="todo-list"] input[type="checkbox"]');
    await checkbox.click();
    const done = await $(".todo-item.done");
    await expect(done).toBeDisplayed();
  });

  it("should delete a todo", async () => {
    const input = await $('[data-testid="todo-input"]');
    await input.setValue("Temporary");
    await input.keys("Enter");
    const deleteBtns = await $$(".delete-btn");
    await deleteBtns[deleteBtns.length - 1].click();
    await browser.pause(200);
    const list = await $('[data-testid="todo-list"]');
    await expect(list).not.toHaveText(expect.stringContaining("Temporary"));
  });
});
