import { defineConfig } from "cypress";
import createBundler from "@bahmutov/cypress-esbuild-preprocessor";
import { addCucumberPreprocessorPlugin } from "@badeball/cypress-cucumber-preprocessor";
import { createEsbuildPlugin } from "@badeball/cypress-cucumber-preprocessor/esbuild";
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

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY ?? "",
    suite: "cypress-cucumber-example",
  },
  e2e: {
    baseUrl: "http://localhost:4444",
    supportFile: "cypress/support/e2e.ts",
    specPattern: "cypress/e2e/**/*.feature",
    async setupNodeEvents(on, config) {
      await addCucumberPreprocessorPlugin(on, config);

      on(
        "file:preprocessor",
        createBundler({ plugins: [createEsbuildPlugin(config)] }),
      );

      await setupFlakey(on, config);

      return config;
    },
  },
});
