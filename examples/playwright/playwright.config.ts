import { defineConfig } from "@playwright/test";
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

const testDirs: Record<string, string> = {
  smoke: "tests/smoke",
  sanity: "tests/sanity",
  regression: "tests/regression",
};

export default defineConfig({
  testDir: testDirs[suite] ?? "tests",
  use: {
    baseURL: "http://localhost:4444",
    screenshot: "only-on-failure",
    video: "on",
    trace: "retain-on-failure",
  },
  reporter: [
    ["list"],
    ["@flakeytesting/playwright-reporter", {
      url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY ?? "",
      suite: `playwright-example-${suite}`,
    }],
  ],
});
