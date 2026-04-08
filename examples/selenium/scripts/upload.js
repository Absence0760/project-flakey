#!/usr/bin/env node

/**
 * Merges mochawesome reports and uploads to Flakey via the CLI.
 * Usage: node scripts/upload.js <suite-suffix>
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync, rmSync, readdirSync } from "fs";

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

// Check if reports exist
if (!existsSync(reportDir) || readdirSync(reportDir).filter(f => f.endsWith(".json")).length === 0) {
  console.error("  [flakey] No reports found in", reportDir);
  process.exit(1);
}

// Merge mochawesome reports
try {
  execSync(`npx mochawesome-merge ${reportDir}/*.json > ${reportDir}/merged.json`, { stdio: "pipe" });
} catch {
  console.error("  [flakey] Failed to merge reports");
  process.exit(1);
}

// Upload via CLI
const result = spawnSync("npx", [
  "tsx", "../../packages/flakey-cli/src/index.ts",
  "--report-dir", reportDir,
  "--suite", `selenium-example-${suite}`,
  "--reporter", "mochawesome",
  "--screenshots-dir", "screenshots",
  "--api-key", apiKey,
], {
  stdio: "inherit",
  env: { ...process.env, FLAKEY_API_URL: apiUrl },
});

// Clean up reports and screenshots for next run
rmSync(reportDir, { recursive: true, force: true });
rmSync("screenshots", { recursive: true, force: true });

process.exit(result.status ?? 1);
