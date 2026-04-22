import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from "fs";
import { join, basename } from "path";
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

// Load .env
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
}

const suite = process.env.SUITE ?? "default";

const specPatterns: Record<string, string[]> = {
  smoke: ["./tests/smoke/**/*.spec.ts"],
  sanity: ["./tests/sanity/**/*.spec.ts"],
  regression: ["./tests/regression/**/*.spec.ts"],
  a11y: ["./tests/a11y/**/*.e2e.ts"],
  visual: ["./tests/visual/**/*.e2e.ts"],
  // Flaky tests are intentionally kept in their own SUITE so they are never
  // accidentally included in smoke/sanity/regression runs.
  flaky: ["./tests/flaky/**/*.e2e.ts"],
};

export const config = {
  runner: "local",
  specs: specPatterns[suite] ?? ["./tests/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [{
    browserName: "chrome",
    "goog:chromeOptions": {
      args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,720"],
    },
  }],
  logLevel: "warn" as const,
  bail: 0,
  baseUrl: "http://localhost:4444",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 30000,
  },
  reporters: [
    "spec",
    [FlakeyReporter, {
      url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY ?? "",
      suite: `webdriverio-example-${suite}`,
      release: process.env.FLAKEY_RELEASE ?? "",
    }],
  ],
  // Screenshot on failure
  afterTest: async function (test: any, _context: any, { error }: any) {
    if (error) {
      const { mkdirSync } = await import("fs");
      mkdirSync("./screenshots", { recursive: true });
      const name = `${test.parent} -- ${test.title} (failed)`.replace(/[^a-zA-Z0-9 _\-()]/g, "");
      await browser.saveScreenshot(`./screenshots/${name}.png`);
    }
  },
};
