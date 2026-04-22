#!/usr/bin/env node
/**
 * Upload Jest JUnit results to Better Testing via the CLI.
 *
 * Usage: node scripts/upload.js <suite-suffix>
 *   suite-suffix: "smoke" | "regression" (appended to "jest-example-")
 *
 * The CLI reads FLAKEY_API_URL (default: http://localhost:3000) and
 * FLAKEY_API_KEY from the environment, or from a .env file in this directory.
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

// Load .env if present
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
}

const suite = process.argv[2] ?? "smoke";
const apiKey = process.env.FLAKEY_API_KEY ?? "";
const apiUrl = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

if (!apiKey) {
  console.error("[flakey] No FLAKEY_API_KEY set. Create a .env file or export the variable.");
  process.exit(1);
}

if (!existsSync("reports/junit.xml")) {
  console.error("[flakey] reports/junit.xml not found. Run tests first.");
  process.exit(1);
}

// Upload JUnit XML via the flakey-upload CLI
const result = spawnSync(
  "npx",
  [
    "tsx", "../../packages/flakey-cli/src/index.ts",
    "--report-dir", "reports",
    "--suite", `jest-example-${suite}`,
    "--reporter", "junit",
    "--api-key", apiKey,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, FLAKEY_API_URL: apiUrl },
  }
);

process.exit(result.status ?? 1);
