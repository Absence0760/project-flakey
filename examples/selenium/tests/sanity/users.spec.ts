import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver, By, until } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";

describe("Users Table", () => {
  let driver: WebDriver;

  before(async () => {
    driver = await createDriver();
  });

  after(async () => {
    await driver?.quit();
  });

  it("should display all users", async () => {
    await driver.get(url("#users"));
    const rows = await driver.findElements(By.css('[data-testid="users-body"] tr'));
    expect(rows.length).to.equal(5);
  });

  it("should be sorted by name ascending by default", async () => {
    await driver.get(url("#users"));
    const firstRow = await driver.findElement(By.css('[data-testid="users-body"] tr:first-child'));
    expect(await firstRow.getText()).to.include("Alice Johnson");
  });

  it("should sort by name descending on click", async () => {
    await driver.get(url("#users"));
    await driver.findElement(By.css('[data-testid="sort-name"]')).click();
    const firstRow = await driver.findElement(By.css('[data-testid="users-body"] tr:first-child'));
    expect(await firstRow.getText()).to.include("Eve Davis");
  });

  it("should open and cancel delete modal", async () => {
    await driver.get(url("#users"));
    await driver.findElement(By.css('[data-testid="delete-alice@test.com"]')).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.css('[data-testid="delete-modal"]'))), 3000);
    await driver.findElement(By.css('[data-testid="cancel-delete"]')).click();
    const rows = await driver.findElements(By.css('[data-testid="users-body"] tr'));
    expect(rows.length).to.equal(5);
  });

  it("should delete a user", async () => {
    await driver.get(url("#users"));
    await driver.findElement(By.css('[data-testid="delete-bob@test.com"]')).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.css('[data-testid="delete-modal"]'))), 3000);
    await driver.findElement(By.css('[data-testid="confirm-delete"]')).click();
    await driver.sleep(500);
    const rows = await driver.findElements(By.css('[data-testid="users-body"] tr'));
    expect(rows.length).to.equal(4);
  });
});
