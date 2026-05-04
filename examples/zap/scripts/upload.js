#!/usr/bin/env node

/**
 * Uploads converted ZAP results to Better Testing.
 *
 * Two-step flow:
 *   1.  JUnit upload via the CLI — produces a run that lives in the normal
 *       runs list / dashboard.
 *   2.  POST /security with the raw zap-report.json — stores normalized
 *       findings on the new security_scans / security_findings tables so
 *       the dashboard can render risk rollups and the raw payload remains
 *       queryable for forensics.
 *
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

// 1. Upload the JUnit summary as a regular run.
const cliArgs = [
  "tsx", "../../packages/flakey-cli/src/index.ts",
  "--report-dir", reportDir,
  "--suite", `zap-example-${suite}`,
  "--reporter", "junit",
  "--api-key", apiKey,
];
if (release) cliArgs.push("--release", release);

const cliResult = spawnSync("npx", cliArgs, {
  stdio: ["inherit", "pipe", "inherit"],
  encoding: "utf-8",
  env: { ...process.env, FLAKEY_API_URL: apiUrl },
});

if (cliResult.stdout) process.stdout.write(cliResult.stdout);

if (cliResult.status !== 0) {
  cleanup();
  process.exit(cliResult.status ?? 1);
}

const RISK_TO_SEVERITY = {
  3: "high",
  2: "medium",
  1: "low",
  0: "info",
};

function stripHtml(s) {
  return typeof s === "string" ? s.replace(/<[^>]*>/g, "").trim() : null;
}

function extractFindings(raw) {
  const out = [];
  for (const site of raw.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const risk = Number(alert.riskcode) || 0;
      out.push({
        rule_id: alert.pluginid ?? alert.alertRef ?? null,
        name: alert.name || alert.alert || "Unknown alert",
        severity: RISK_TO_SEVERITY[risk] ?? "info",
        description: stripHtml(alert.desc),
        solution: stripHtml(alert.solution),
        url: alert.instances?.[0]?.uri ?? null,
        cwe: alert.cweid ? String(alert.cweid) : null,
        instances: alert.instances?.length ?? 1,
        metadata: { confidence: alert.confidence, wascid: alert.wascid },
      });
    }
  }
  return out;
}

function cleanup() {
  rmSync(reportDir, { recursive: true, force: true });
  rmSync("zap-report.json", { force: true });
  rmSync("zap-report.xml", { force: true });
}

// 2. POST the raw ZAP JSON to /security so the dashboard gets normalized
//    findings + the raw payload.  Best-effort — if it fails the run upload
//    above still landed.
const runIdMatch = (cliResult.stdout || "").match(/run\s+#(\d+)/i);
const runId = runIdMatch ? Number(runIdMatch[1]) : null;

if (runId && existsSync("zap-report.json")) {
  try {
    const raw = JSON.parse(readFileSync("zap-report.json", "utf-8"));
    const findings = extractFindings(raw);
    const targetUrl = (raw.site?.[0]?.["@name"] ?? "") || "";

    const res = await fetch(`${apiUrl}/security`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        run_id: runId,
        scanner: "zap",
        target: targetUrl,
        findings,
        raw_report: raw,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`  [flakey] Uploaded ${findings.length} ZAP finding(s) to /security (run #${runId})`);
      console.log(`            high=${data.high_count} medium=${data.medium_count} low=${data.low_count} info=${data.info_count}`);
    } else {
      console.warn(`  [flakey] POST /security failed (${res.status}); JUnit run was still uploaded`);
    }
  } catch (err) {
    console.warn(`  [flakey] POST /security skipped: ${err instanceof Error ? err.message : err}`);
  }
} else if (!runId) {
  console.warn(`  [flakey] Could not parse run id from CLI output; skipping /security upload`);
}

cleanup();
process.exit(0);
