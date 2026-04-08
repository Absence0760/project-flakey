import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver, By } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";

describe("Form", () => {
  let driver: WebDriver;

  before(async () => {
    driver = await createDriver();
  });

  after(async () => {
    await driver?.quit();
  });

  it("should display the form with default values", async () => {
    await driver.get(url("#form"));
    const form = await driver.findElement(By.css('[data-testid="create-form"]'));
    expect(await form.isDisplayed()).to.be.true;
    const priority = await driver.findElement(By.css('[data-testid="item-priority"]'));
    expect(await priority.getAttribute("value")).to.equal("medium");
  });

  it("should submit with all fields", async () => {
    await driver.get(url("#form"));
    await driver.findElement(By.css('[data-testid="item-name"]')).sendKeys("New feature");
    await driver.findElement(By.css('[data-testid="item-category"]')).sendKeys("feature");
    await driver.findElement(By.css('[data-testid="item-priority"]')).sendKeys("high");
    await driver.findElement(By.css('[data-testid="item-description"]')).sendKeys("A great feature");
    await driver.findElement(By.css('[data-testid="item-urgent"]')).click();
    await driver.findElement(By.css('[data-testid="submit-form"]')).click();
    const result = await driver.findElement(By.css('[data-testid="form-result"]'));
    expect(await result.isDisplayed()).to.be.true;
    expect(await result.getText()).to.include("New feature");
  });

  it("should reset the form", async () => {
    await driver.get(url("#form"));
    await driver.findElement(By.css('[data-testid="item-name"]')).sendKeys("Something");
    await driver.findElement(By.css('[data-testid="item-urgent"]')).click();
    await driver.findElement(By.css('[data-testid="reset-form"]')).click();
    const name = await driver.findElement(By.css('[data-testid="item-name"]'));
    expect(await name.getAttribute("value")).to.equal("");
  });
});
