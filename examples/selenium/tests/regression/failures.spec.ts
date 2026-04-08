import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver, By, Key, until } from "selenium-webdriver";
import { createDriver, url, takeScreenshot } from "../helpers.js";

describe("Intentional Failures", () => {
  let driver: WebDriver;

  before(async () => {
    driver = await createDriver();
  });

  after(async () => {
    await driver?.quit();
  });

  it("should fail - element does not exist", async () => {
    await driver.get(url("#login"));
    await takeScreenshot(driver, "Intentional Failures -- should fail - element does not exist (failed)");
    const elements = await driver.findElements(By.css('[data-testid="nonexistent-button"]'));
    expect(elements.length).to.be.greaterThan(0, "Expected element to exist");
  });

  it("should fail - wrong text content", async () => {
    await driver.get(url("#login"));
    const button = await driver.findElement(By.css('[data-testid="login-button"]'));
    await takeScreenshot(driver, "Intentional Failures -- should fail - wrong text content (failed)");
    const text = await button.getText();
    expect(text).to.equal("Submit Form");
  });

  it("should fail - login then wrong assertion", async () => {
    await driver.get(url("#login"));
    const emailInput = await driver.findElement(By.css('[data-testid="email-input"]'));
    await emailInput.clear();
    await emailInput.sendKeys("admin@test.com");
    const passInput = await driver.findElement(By.css('[data-testid="password-input"]'));
    await passInput.clear();
    await passInput.sendKeys("password");
    await driver.findElement(By.css('[data-testid="login-button"]')).click();
    await driver.wait(until.elementLocated(By.css('[data-testid="todos-page"]')), 10000);
    await driver.wait(until.elementIsVisible(driver.findElement(By.css('[data-testid="todo-input"]'))), 5000);
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Buy milk", Key.ENTER);
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    expect(await list.getText()).to.include("Buy milk");
    const count = await driver.findElement(By.css('[data-testid="todo-count"]'));
    await takeScreenshot(driver, "Intentional Failures -- should fail - login then wrong assertion (failed)");
    expect(await count.getText()).to.include("99 items");
  });
});
