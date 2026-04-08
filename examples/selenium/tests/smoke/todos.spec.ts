import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver, By, Key, until } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";

describe("Todos", () => {
  let driver: WebDriver;

  before(async () => {
    driver = await createDriver();
  });

  after(async () => {
    await driver?.quit();
  });

  it("should add a new todo", async () => {
    await driver.get(url("#todos"));
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Buy groceries");
    await driver.findElement(By.css('[data-testid="add-todo"]')).click();
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    expect(await list.getText()).to.include("Buy groceries");
  });

  it("should add a todo with Enter key", async () => {
    await driver.get(url("#todos"));
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Walk the dog", Key.ENTER);
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    expect(await list.getText()).to.include("Walk the dog");
  });

  it("should mark a todo as completed", async () => {
    await driver.get(url("#todos"));
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Read a book", Key.ENTER);
    const checkbox = await driver.findElement(By.css('[data-testid="todo-list"] input[type="checkbox"]'));
    await checkbox.click();
    const done = await driver.findElement(By.css(".todo-item.done"));
    expect(await done.isDisplayed()).to.be.true;
  });

  it("should delete a todo", async () => {
    await driver.get(url("#todos"));
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Temporary", Key.ENTER);
    // Delete the last added item
    const deleteBtns = await driver.findElements(By.css(".delete-btn"));
    await deleteBtns[deleteBtns.length - 1].click();
    await driver.sleep(200);
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    expect(await list.getText()).to.not.include("Temporary");
  });
});
