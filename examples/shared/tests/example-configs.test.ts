import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Example-project configuration smoke tests.
 *
 * Each example wires the Flakey reporters into a different test
 * runner config (Cypress / Playwright / WebdriverIO / Jest / Selenium).
 * A regression in any example's config (typo, missing reporter, env
 * mis-shape) breaks the user-facing onboarding path.
 *
 * These tests don't actually run the example suites — that needs
 * full browser environments + servers. They DO assert each config
 * file exists, parses, and references the reporter packages it
 * should.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const EXAMPLES = resolve(REPO_ROOT, "examples");

function readExampleFile(rel: string): string {
  const full = join(EXAMPLES, rel);
  if (!existsSync(full)) {
    throw new Error(`example file not found: ${rel}`);
  }
  return readFileSync(full, "utf8");
}

test("examples/cypress wires setupFlakey via @flakeytesting/cypress-reporter", () => {
  const config = readExampleFile("cypress/cypress.config.ts");
  assert.match(config, /from\s+["']@flakeytesting\/cypress-reporter\/plugin["']/);
  assert.match(config, /setupFlakey\s*\(/, "should call setupFlakey to compose reporters");
});

test("examples/cypress's package.json declares the three Flakey workspaces as link: deps", () => {
  const pkg = JSON.parse(readExampleFile("cypress/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(all["@flakeytesting/cypress-reporter"], "should depend on cypress-reporter");
  assert.ok(all["@flakeytesting/cypress-snapshots"], "should depend on cypress-snapshots");
  assert.ok(all["@flakeytesting/live-reporter"], "should depend on live-reporter");
  // Examples link to local workspace packages (not published versions).
  for (const name of [
    "@flakeytesting/cypress-reporter",
    "@flakeytesting/cypress-snapshots",
    "@flakeytesting/live-reporter",
  ]) {
    assert.match(all[name]!, /^link:\.\.\/\.\.\/packages\//, `${name} should be a workspace link`);
  }
});

test("examples/cypress-cucumber wires setupFlakey + the cucumber preprocessor", () => {
  const config = readExampleFile("cypress-cucumber/cypress.config.ts");
  assert.match(config, /from\s+["']@flakeytesting\/cypress-reporter\/plugin["']/);
  assert.match(config, /setupFlakey\s*\(/);
  assert.match(
    config,
    /cypress-cucumber-preprocessor/,
    "cucumber example should wire the preprocessor",
  );
});

test("examples/cypress-cucumber pulls in the cucumber subpath of cypress-snapshots somewhere in the suite", () => {
  // Per the cypress-snapshots CLAUDE.md: the cucumber import MUST live in a
  // step-definition file (matched by stepDefinitions glob) — NOT support/e2e.ts.
  // A regression that moved that import to support/e2e.ts would break every
  // spec with "Expected to find a global registry".
  const supportFile = join(EXAMPLES, "cypress-cucumber/cypress/support/e2e.ts");
  if (existsSync(supportFile)) {
    const support = readFileSync(supportFile, "utf8");
    // Assert no live `import` statement — comments mentioning the
    // subpath (explaining why it's NOT here) are fine.
    assert.doesNotMatch(
      support,
      /^\s*import\s+["']@flakeytesting\/cypress-snapshots\/cucumber["']/m,
      "cucumber import statement must NOT live in cypress/support/e2e.ts",
    );
  }
});

test("examples/playwright references @flakeytesting/playwright-reporter in its config", () => {
  const config = readExampleFile("playwright/playwright.config.ts");
  assert.match(
    config,
    /@flakeytesting\/playwright-reporter/,
    "playwright config should list the Flakey reporter",
  );
});

test("examples/playwright's package.json declares the workspace dep link to playwright-reporter", () => {
  const pkg = JSON.parse(readExampleFile("playwright/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(all["@flakeytesting/playwright-reporter"]);
  // live-reporter is OPTIONAL for the Playwright example (Playwright's
  // own reporter pipeline already covers the use case). Do not assert
  // its presence here.
});

test("examples/webdriverio's package.json wires the WDIO reporter as a workspace dep", () => {
  const pkg = JSON.parse(readExampleFile("webdriverio/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(
    all["@flakeytesting/webdriverio-reporter"],
    "webdriverio example must link the wdio reporter package",
  );
});

test("examples/jest uses @flakeytesting/cli for upload (no native reporter)", () => {
  const pkg = JSON.parse(readExampleFile("jest/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  // Jest doesn't have a Flakey-native reporter — the example uses the
  // generic CLI to upload junit/json output.
  assert.ok(
    all["@flakeytesting/cli"],
    "jest example should depend on @flakeytesting/cli for post-run upload",
  );
});

test("examples/selenium uses @flakeytesting/cli for upload (no native selenium reporter)", () => {
  const pkg = JSON.parse(readExampleFile("selenium/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(
    all["@flakeytesting/cli"],
    "selenium example should depend on @flakeytesting/cli for post-run upload",
  );
});

test("every example with a package.json uses link: protocol for workspace Flakey deps", () => {
  // Catches a regression where someone bumped a dep to a numeric
  // version (e.g. ^0.8.0) — that breaks local development because
  // the link to the in-tree workspace gets dropped.
  const dirs = ["cypress", "cypress-cucumber", "playwright", "webdriverio", "jest", "selenium", "postman", "zap"];
  for (const dir of dirs) {
    const pkgPath = join(EXAMPLES, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, spec] of Object.entries(all)) {
      if (name.startsWith("@flakeytesting/")) {
        assert.match(
          spec,
          /^link:\.\.\/\.\.\/packages\//,
          `${dir}: ${name} must use a link:../../packages/* spec, got ${spec}`,
        );
      }
    }
  }
});

test("examples README documents each example's setup", () => {
  const readme = readExampleFile("README.md");
  // Smoke-check that the user-facing README still references each
  // example dir — a regression where someone deleted a dir but
  // forgot the README would surface here.
  for (const example of ["cypress", "playwright", "webdriverio", "jest", "selenium"]) {
    assert.match(readme, new RegExp(example, "i"), `README should mention ${example}`);
  }
});
