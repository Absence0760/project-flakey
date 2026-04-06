#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const API_URL = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

interface UploadOptions {
  reportDir: string;
  suiteName: string;
  branch: string;
  commitSha: string;
  ciRunId: string;
  reporter: string;
}

function parseArgs(): UploadOptions {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1] ?? "";
      i++;
    }
  }

  return {
    reportDir: resolve(opts["report-dir"] ?? "cypress/reports"),
    suiteName: opts["suite"] ?? "default",
    branch: opts["branch"] ?? process.env.BRANCH ?? "",
    commitSha: opts["commit"] ?? process.env.COMMIT_SHA ?? "",
    ciRunId: opts["ci-run-id"] ?? process.env.CI_RUN_ID ?? "",
    reporter: opts["reporter"] ?? "mochawesome",
  };
}

function findReportFile(dir: string): string | null {
  if (!existsSync(dir)) return null;

  // Look for merged mochawesome report first
  const merged = join(dir, "mochawesome.json");
  if (existsSync(merged)) return merged;

  // Fall back to any JSON file
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.length > 0 ? join(dir, files[0]) : null;
}

async function upload(opts: UploadOptions): Promise<void> {
  const reportFile = findReportFile(opts.reportDir);

  if (!reportFile) {
    console.error(`No report files found in ${opts.reportDir}`);
    process.exit(1);
  }

  console.log(`Found report: ${reportFile}`);

  const raw = JSON.parse(readFileSync(reportFile, "utf-8"));

  const payload = {
    reporter: opts.reporter,
    meta: {
      suite_name: opts.suiteName,
      branch: opts.branch,
      commit_sha: opts.commitSha,
      ci_run_id: opts.ciRunId,
      started_at: "",
      finished_at: "",
      reporter: opts.reporter,
    },
    raw,
  };

  const res = await fetch(`${API_URL}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Upload failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const result = await res.json();
  console.log(`Uploaded run #${(result as { id: number }).id} to ${API_URL}`);
}

const opts = parseArgs();
upload(opts);
