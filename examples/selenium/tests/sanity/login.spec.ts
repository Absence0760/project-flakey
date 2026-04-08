import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver, By, until } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";

describe("Login", () => {
  let driver: WebDriver;

  before(async () => {
    driver = await createDriver();
  });

  after(async () => {
    await driver?.quit();
  });

  it("should show the login form", async () => {
    await driver.get(url("#login"));
    const form = await driver.findElement(By.css('[data-testid="login-form"]'));
    expect(await form.isDisplayed()).to.be.true;
  });

  it("should login with valid credentials", async () => {
    await driver.get(url("#login"));
    await driver.findElement(By.css('[data-testid="email-input"]')).sendKeys("admin@test.com");
    await driver.findElement(By.css('[data-testid="password-input"]')).sendKeys("password");
    await driver.findElement(By.css('[data-testid="login-button"]')).click();
    await driver.wait(until.elementLocated(By.css('[data-testid="login-success"]')), 5000);
    const success = await driver.findElement(By.css('[data-testid="login-success"]'));
    expect(await success.isDisplayed()).to.be.true;
  });

  it("should show error with invalid credentials", async () => {
    await driver.get(url("#login"));
    await driver.findElement(By.css('[data-testid="email-input"]')).sendKeys("wrong@test.com");
    await driver.findElement(By.css('[data-testid="password-input"]')).sendKeys("wrong");
    await driver.findElement(By.css('[data-testid="login-button"]')).click();
    // Wait for the error element's display to change from "none" to "block"
    await driver.wait(async () => {
      const el = await driver.findElement(By.css('[data-testid="login-error"]'));
      const display = await el.getCssValue("display");
      return display !== "none";
    }, 5000);
    const error = await driver.findElement(By.css('[data-testid="login-error"]'));
    expect(await error.isDisplayed()).to.be.true;
  });
});
