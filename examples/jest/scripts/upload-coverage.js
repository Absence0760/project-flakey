#!/usr/bin/env node
/**
 * Upload Jest coverage summary to Better Testing.
 *
 * Prerequisites:
 *   1. Run tests with coverage first:
 *        pnpm test:smoke   (writes coverage/smoke/coverage-summary.json)
 *      or pnpm test:regression (writes coverage/regression/coverage-summary.json)
 *
 *   2. The upload requires a run ID from a previous result upload.
 *      Pass it via --run-id or RUN_ID env var.
 *
 * Usage:
 *   RUN_ID=42 node scripts/upload-coverage.js [--coverage-dir coverage/smoke]
 *
 * Jest produces coverage/coverage-summary.json (Istanbul format) when run with
 * --coverage --coverageReporters=json-summary. The flakey-upload CLI accepts
 * this file via the "coverage" subcommand.
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

// Parse --coverage-dir and --run-id args
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const coverageDir = getArg("--coverage-dir") ?? "coverage";
const runId = getArg("--run-id") ?? process.env.RUN_ID ?? "";
const apiKey = process.env.FLAKEY_API_KEY ?? "";
const apiUrl = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

if (!apiKey) {
  console.error("[flakey] No FLAKEY_API_KEY set. Create a .env file or export the variable.");
  process.exit(1);
}

if (!runId) {
  console.error("[flakey] No run ID provided. Pass --run-id <id> or set RUN_ID env var.");
  console.error("         Get the run ID from the output of the upload step.");
  process.exit(1);
}

const coverageFile = `${coverageDir}/coverage-summary.json`;
if (!existsSync(coverageFile)) {
  console.error(`[flakey] Coverage file not found: ${coverageFile}`);
  console.error("         Run: pnpm test:smoke (or test:regression) to generate it.");
  process.exit(1);
}

console.log(`[flakey] Uploading coverage from ${coverageFile} for run #${runId}`);

const result = spawnSync(
  "npx",
  [
    "tsx", "../../packages/flakey-cli/src/index.ts",
    "coverage",
    "--run-id", runId,
    "--file", coverageFile,
    "--api-key", apiKey,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, FLAKEY_API_URL: apiUrl },
  }
);

process.exit(result.status ?? 1);
