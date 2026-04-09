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
};

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY ?? "",
    suite: `cypress-example-${suite}`,
  },
  e2e: {
    baseUrl: "http://localhost:4444",
    supportFile: "cypress/support/e2e.ts",
    specPattern: specPatterns[suite] ?? "cypress/e2e/**/*.cy.ts",
    video: true,
    async setupNodeEvents(on, config) {
      await setupFlakey(on, config);
      return config;
    },
  },
});
