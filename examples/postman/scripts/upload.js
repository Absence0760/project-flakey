#!/usr/bin/env node

/**
 * Uploads Newman JUnit results to Flakey via the CLI.
 * Usage: node scripts/upload.js <suite-suffix>
 */

import { spawnSync } from "child_process";
import { readFileSync, existsSync, rmSync } from "fs";

// Load .env
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
}

const suite = process.argv[2] ?? "default";
const reportDir = "reports";
const apiKey = process.env.FLAKEY_API_KEY ?? "";
const apiUrl = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

if (!apiKey) {
  console.error("  [flakey] No FLAKEY_API_KEY set. Create a .env file or export the variable.");
  process.exit(1);
}

if (!existsSync(`${reportDir}/results.xml`)) {
  console.error("  [flakey] No report found at", `${reportDir}/results.xml`);
  process.exit(1);
}

// Upload via CLI
const result = spawnSync("npx", [
  "tsx", "../../packages/flakey-cli/src/index.ts",
  "--report-dir", reportDir,
  "--suite", `postman-example-${suite}`,
  "--reporter", "junit",
  "--api-key", apiKey,
], {
  stdio: "inherit",
  env: { ...process.env, FLAKEY_API_URL: apiUrl },
});

// Clean up reports for next run
rmSync(reportDir, { recursive: true, force: true });

process.exit(result.status ?? 1);
