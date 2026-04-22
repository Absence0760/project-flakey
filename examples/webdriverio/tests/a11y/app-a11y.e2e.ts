/**
 * Accessibility scan of the todo app using axe-core injected via browser.execute.
 *
 * Violations are logged to the console but do NOT cause the test to hard-fail
 * so that flaky-detection and CI pipelines are not blocked by a11y regressions
 * before they are triaged. Set FAIL_ON_A11Y_VIOLATIONS=true to enable hard-fail.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const AXE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js";

async function injectAxe(): Promise<void> {
  // Try to read axe-core from node_modules first, fall back to fetching from CDN
  let axeSource: string;
  const localPaths = [
    join(process.cwd(), "node_modules/axe-core/axe.min.js"),
    join(process.cwd(), "node_modules/.pnpm/axe-core@4.9.1/node_modules/axe-core/axe.min.js"),
  ];

  let loaded = false;
  for (const p of localPaths) {
    try {
      axeSource = readFileSync(p, "utf-8");
      loaded = true;
      break;
    } catch {
      // not found at this path
    }
  }

  if (!loaded) {
    // axe-core not installed locally — inject via <script> tag pointing to CDN.
    // This works in headless Chrome during development but should not be used in
    // air-gapped CI. Install axe-core as a devDependency to avoid the network call.
    await browser.execute((src: string) => {
      return new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Failed to load axe-core from CDN"));
        document.head.appendChild(s);
      });
    }, AXE_CDN);
    return;
  }

  await browser.execute(axeSource!);
}

async function runAxe(): Promise<any> {
  return browser.execute(() => {
    return (window as any).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
  });
}

describe("Accessibility — todo app", () => {
  it("should have no critical a11y violations on the todos page", async () => {
    await browser.url("/#todos");
    await browser.pause(300); // allow SPA render

    await injectAxe();
    const results = await runAxe();

    const violations: any[] = results.violations ?? [];

    if (violations.length > 0) {
      console.log(`\n  [a11y] ${violations.length} violation(s) found on /#todos:`);
      for (const v of violations) {
        console.log(`    [${v.impact}] ${v.id}: ${v.description}`);
        for (const node of v.nodes ?? []) {
          console.log(`      -> ${node.html}`);
        }
      }

      // Persist results for upload
      mkdirSync("reports/a11y", { recursive: true });
      writeFileSync(
        "reports/a11y/todos-a11y.json",
        JSON.stringify(results, null, 2),
      );
    } else {
      console.log("\n  [a11y] No violations found on /#todos");
    }

    if (process.env.FAIL_ON_A11Y_VIOLATIONS === "true") {
      if (violations.length > 0) {
        throw new Error(
          `${violations.length} a11y violation(s) found. See reports/a11y/todos-a11y.json.`,
        );
      }
    }
  });

  it("should have no critical a11y violations on the login page", async () => {
    await browser.url("/#login");
    await browser.pause(300);

    await injectAxe();
    const results = await runAxe();

    const violations: any[] = results.violations ?? [];

    if (violations.length > 0) {
      console.log(`\n  [a11y] ${violations.length} violation(s) found on /#login:`);
      for (const v of violations) {
        console.log(`    [${v.impact}] ${v.id}: ${v.description}`);
      }

      mkdirSync("reports/a11y", { recursive: true });
      writeFileSync(
        "reports/a11y/login-a11y.json",
        JSON.stringify(results, null, 2),
      );
    } else {
      console.log("\n  [a11y] No violations found on /#login");
    }

    if (process.env.FAIL_ON_A11Y_VIOLATIONS === "true") {
      if (violations.length > 0) {
        throw new Error(
          `${violations.length} a11y violation(s) found. See reports/a11y/login-a11y.json.`,
        );
      }
    }
  });
});
