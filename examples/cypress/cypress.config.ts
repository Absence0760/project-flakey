import { defineConfig } from "cypress";
import { setupFlakey } from "@flakeytesting/cypress-reporter/plugin";
import { readFileSync, existsSync } from "fs";

// Load .env file if it exists
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
}

const suite = process.env.SUITE ?? "default";

const specPatterns: Record<string, string> = {
  sanity: "cypress/e2e/sanity/**/*.cy.ts",
  regression: "cypress/e2e/regression/**/*.cy.ts",
  smoke: "cypress/e2e/smoke/**/*.cy.ts",
  live: "cypress/e2e/live/**/*.cy.ts",
  // a11y and flaky are intentionally NOT included in "smoke" or "all" —
  // run them independently via `pnpm test:a11y` / `pnpm test:flaky`.
  a11y: "cypress/e2e/a11y/**/*.cy.ts",
  flaky: "cypress/e2e/flaky/**/*.cy.ts",
};

// NOTE: release metadata tagging — FlakeyReporterOptions does not yet expose
// a `release` field, so FLAKEY_RELEASE is captured here as a comment pattern.
// Once the reporter adds the field, uncomment the `release` line in
// reporterOptions below.  Tracking: "reporter doesn't expose release yet".
// const release = process.env.FLAKEY_RELEASE ?? "";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY ?? "",
    suite: `cypress-example-${suite}`,
    // release,  // uncomment when @flakeytesting/cypress-reporter adds release support
  },
  e2e: {
    baseUrl: "http://localhost:4444",
    supportFile: "cypress/support/e2e.ts",
    specPattern: specPatterns[suite] ?? "cypress/e2e/**/*.cy.ts",
    video: true,
    async setupNodeEvents(on, config) {
      // setupFlakey wires up flakeyReporter + flakeySnapshots + live-reporter.
      await setupFlakey(on, config);
      return config;
    },
  },
});
