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
  // New suites — not included in test:all to keep CI fast by default
  a11y: "tests/a11y",
  visual: "tests/visual",
  flaky: "tests/flaky",
};

export default defineConfig({
  testDir: testDirs[suite] ?? "tests",
  use: {
    baseURL: "http://localhost:4444",
    screenshot: "only-on-failure",
    video: "on",
    trace: "on",
  },
  reporter: [
    ["list"],
    // @flakeytesting/playwright-reporter uploads results + artifacts to the Better Testing
    // backend. It also parses Playwright trace (.zip) files via @flakeytesting/playwright-snapshots
    // to extract per-step DOM snapshots and command logs — that's why trace: "on" is set below.
    // The snapshots are written to playwright-snapshots/ at runtime and uploaded with each run.
    //
    // When FLAKEY_RELEASE is set, the backend upserts the release by version
    // and links this run into it. Reporter also reads process.env.FLAKEY_RELEASE
    // directly as a fallback.
    ["@flakeytesting/playwright-reporter", {
      url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY ?? "",
      suite: `playwright-example-${suite}`,
      release: process.env.FLAKEY_RELEASE ?? "",
    }],
  ],
});
