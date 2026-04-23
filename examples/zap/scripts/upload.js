#!/usr/bin/env node

/**
 * Uploads converted ZAP JUnit results to Flakey via the CLI.
 * Usage: node scripts/upload.js <suite-suffix>
 *
 * Optional env vars:
 *   FLAKEY_RELEASE  — link this run to a named release (e.g. "v1.2.0")
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
const reportDir = "results";
const apiKey = process.env.FLAKEY_API_KEY ?? "";
const apiUrl = process.env.FLAKEY_API_URL ?? "http://localhost:3000";
const release = process.env.FLAKEY_RELEASE ?? "";

if (!apiKey) {
  console.error("  [flakey] No FLAKEY_API_KEY set. Create a .env file or export the variable.");
  process.exit(1);
}

if (!existsSync(`${reportDir}/zap-results.xml`)) {
  console.error("  [flakey] No report found at", `${reportDir}/zap-results.xml`);
  process.exit(1);
}

// Upload via CLI
const cliArgs = [
  "tsx", "../../packages/flakey-cli/src/index.ts",
  "--report-dir", reportDir,
  "--suite", `zap-example-${suite}`,
  "--reporter", "junit",
  "--api-key", apiKey,
];
if (release) cliArgs.push("--release", release);

const result = spawnSync("npx", cliArgs, {
  stdio: "inherit",
  env: { ...process.env, FLAKEY_API_URL: apiUrl },
});

// Clean up reports for next run
rmSync(reportDir, { recursive: true, force: true });
rmSync("zap-report.json", { force: true });
rmSync("zap-report.xml", { force: true });

process.exit(result.status ?? 1);
