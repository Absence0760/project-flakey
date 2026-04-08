import { Builder, Browser, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const BASE_URL = "http://localhost:4444";

export async function createDriver(): Promise<WebDriver> {
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,720");

  const driver = await new Builder()
    .forBrowser(Browser.CHROME)
    .setChromeOptions(options)
    .build();

  return driver;
}

export function url(path: string): string {
  return `${BASE_URL}/${path}`;
}

export async function takeScreenshot(driver: WebDriver, name: string): Promise<void> {
  const data = await driver.takeScreenshot();
  mkdirSync("screenshots", { recursive: true });
  writeFileSync(join("screenshots", `${name}.png`), Buffer.from(data, "base64"));
}
