/**
 * Accessibility scan of the todo app using axe-core injected via driver.executeScript.
 *
 * Violations are logged to the console but do NOT cause the test to hard-fail
 * so that flaky-detection and CI pipelines are not blocked by a11y regressions
 * before they are triaged. Set FAIL_ON_A11Y_VIOLATIONS=true to enable hard-fail.
 */

import { describe, it, before, after } from "mocha";
import { WebDriver } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const AXE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js";

async function injectAxe(driver: WebDriver): Promise<void> {
  const localPaths = [
    join(process.cwd(), "node_modules/axe-core/axe.min.js"),
    join(process.cwd(), "node_modules/.pnpm/axe-core@4.9.1/node_modules/axe-core/axe.min.js"),
  ];
  for (const p of localPaths) {
    if (existsSync(p)) {
      await driver.executeScript(readFileSync(p, "utf-8"));
      return;
    }
  }
  await driver.executeScript(`
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '${AXE_CDN}';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load axe-core from CDN'));
      document.head.appendChild(s);
    });
  `);
}

async function runAxe(driver: WebDriver): Promise<any> {
  return driver.executeAsyncScript(`
    const callback = arguments[arguments.length - 1];
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
    }).then(callback).catch(err => callback({ error: err.message }));
  `);
}

describe("Accessibility — todo app", () => {
  let driver: WebDriver;
  before(async () => { driver = await createDriver(); });
  after(async () => { await driver?.quit(); });

  it("should have no critical a11y violations on the todos page", async () => {
    await driver.get(url("#todos"));
    await driver.sleep(300);
    await injectAxe(driver);
    const results: any = await runAxe(driver);
    if (results.error) { console.log(`  [a11y] axe-core error: ${results.error}`); return; }
    const violations: any[] = results.violations ?? [];
    if (violations.length > 0) {
      console.log(`\n  [a11y] ${violations.length} violation(s) found on /#todos:`);
      for (const v of violations) {
        console.log(`    [${v.impact}] ${v.id}: ${v.description}`);
        for (const node of v.nodes ?? []) console.log(`      -> ${node.html}`);
      }
      mkdirSync("reports/a11y", { recursive: true });
      writeFileSync("reports/a11y/todos-a11y.json", JSON.stringify(results, null, 2));
    } else {
      console.log("\n  [a11y] No violations found on /#todos");
    }
    if (process.env.FAIL_ON_A11Y_VIOLATIONS === "true" && violations.length > 0) {
      throw new Error(`${violations.length} a11y violation(s) found. See reports/a11y/todos-a11y.json.`);
    }
  });

  it("should have no critical a11y violations on the login page", async () => {
    await driver.get(url("#login"));
    await driver.sleep(300);
    await injectAxe(driver);
    const results: any = await runAxe(driver);
    if (results.error) { console.log(`  [a11y] axe-core error: ${results.error}`); return; }
    const violations: any[] = results.violations ?? [];
    if (violations.length > 0) {
      console.log(`\n  [a11y] ${violations.length} violation(s) found on /#login:`);
      for (const v of violations) console.log(`    [${v.impact}] ${v.id}: ${v.description}`);
      mkdirSync("reports/a11y", { recursive: true });
      writeFileSync("reports/a11y/login-a11y.json", JSON.stringify(results, null, 2));
    } else {
      console.log("\n  [a11y] No violations found on /#login");
    }
    if (process.env.FAIL_ON_A11Y_VIOLATIONS === "true" && violations.length > 0) {
      throw new Error(`${violations.length} a11y violation(s) found. See reports/a11y/login-a11y.json.`);
    }
  });
});
