/**
 * Intentionally flaky tests (~30% failure rate).
 *
 * Used to exercise the Better Testing flaky-detection feature.
 * NOT included in smoke/sanity/regression spec patterns — use test:flaky.
 */

import { describe, it, before, after } from "mocha";
import { By, WebDriver } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";

describe("Intentionally flaky — network timing", () => {
  let driver: WebDriver;
  before(async () => { driver = await createDriver(); });
  after(async () => { await driver?.quit(); });
  it("should sometimes fail due to timing variance", async () => {
    await driver.get(url("#todos"));
    await driver.sleep(100);
    const roll = Math.random();
    if (roll < 0.3) throw new Error(`Flaky failure triggered (roll=${roll.toFixed(3)}). This is intentional.`);
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    if (!await input.isDisplayed()) throw new Error("todo-input not displayed");
  });
});

describe("Intentionally flaky — race condition simulation", () => {
  let driver: WebDriver;
  before(async () => { driver = await createDriver(); });
  after(async () => { await driver?.quit(); });
  it("should sometimes fail as if an element is not yet rendered", async () => {
    await driver.get(url("#todos"));
    const roll = Math.random();
    if (roll < 0.3) throw new Error(`Flaky race condition triggered (roll=${roll.toFixed(3)}). This is intentional.`);
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    if (!list) throw new Error("todo-list not found");
  });
});

describe("Intentionally flaky — stale element simulation", () => {
  let driver: WebDriver;
  before(async () => { driver = await createDriver(); });
  after(async () => { await driver?.quit(); });
  it("should sometimes fail as if a DOM node was replaced", async () => {
    await driver.get(url("#todos"));
    await driver.sleep(150);
    const roll = Math.random();
    if (roll < 0.3) throw new Error(`Flaky stale-element triggered (roll=${roll.toFixed(3)}). This is intentional.`);
    const input = await driver.findElement(By.css('[data-testid="todo-input"]'));
    await input.sendKeys("Flaky item");
    await driver.findElement(By.css('[data-testid="add-todo"]')).click();
    const list = await driver.findElement(By.css('[data-testid="todo-list"]'));
    const text = await list.getText();
    if (!text.includes("Flaky item")) throw new Error("Flaky item not found in list");
  });
});
