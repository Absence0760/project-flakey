#!/usr/bin/env node

/**
 * Uploads coverage/coverage-summary.json to the Better Testing backend.
 *
 * Usage: node scripts/upload-coverage.js --run-id <id>
 *
 * FLAKEY_RELEASE is forwarded to the CLI as --release; the backend upserts
 * the release and links the run via release_runs.
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
}

const apiKey = process.env.FLAKEY_API_KEY ?? "";
const apiUrl = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

if (!apiKey) {
  console.error("  [flakey] No FLAKEY_API_KEY set. Create a .env file or export the variable.");
  process.exit(1);
}

const args = process.argv.slice(2);
const runIdIdx = args.indexOf("--run-id");
const runId = runIdIdx !== -1 ? args[runIdIdx + 1] : "";

if (!runId) {
  console.error("  [flakey] Usage: node scripts/upload-coverage.js --run-id <id>");
  process.exit(1);
}

const coverageFile = "coverage/coverage-summary.json";
if (!existsSync(coverageFile)) {
  console.error(`  [flakey] Coverage file not found: ${coverageFile}`);
  process.exit(1);
}

console.log(`  [flakey] Uploading coverage from ${coverageFile} for run #${runId}`);

const cliArgs = [
  "tsx", "../../packages/flakey-cli/src/index.ts",
  "coverage",
  "--run-id", runId,
  "--file", coverageFile,
  "--api-key", apiKey,
];
const release = process.env.FLAKEY_RELEASE ?? "";
if (release) cliArgs.push("--release", release);

const result = spawnSync("npx", cliArgs, {
  stdio: "inherit",
  env: { ...process.env, FLAKEY_API_URL: apiUrl },
});

process.exit(result.status ?? 1);
