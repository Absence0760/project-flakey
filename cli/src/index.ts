#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename } from "path";

const API_URL = process.env.FLAKEY_API_URL ?? "http://localhost:3000";

interface UploadOptions {
  reportDir: string;
  suiteName: string;
  branch: string;
  commitSha: string;
  ciRunId: string;
  reporter: string;
  screenshotsDir: string;
  videosDir: string;
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
    screenshotsDir: resolve(opts["screenshots-dir"] ?? "cypress/screenshots"),
    videosDir: resolve(opts["videos-dir"] ?? "cypress/videos"),
  };
}

function findReportFile(dir: string, reporter: string): { path: string; isXml: boolean } | null {
  if (!existsSync(dir)) return null;

  if (reporter === "junit") {
    // Look for XML files for JUnit
    const xmlFiles = readdirSync(dir).filter((f) => f.endsWith(".xml"));
    if (xmlFiles.length > 0) return { path: join(dir, xmlFiles[0]), isXml: true };
    return null;
  }

  if (reporter === "playwright") {
    // Playwright uses JSON reporter output
    const pwFile = join(dir, "results.json");
    if (existsSync(pwFile)) return { path: pwFile, isXml: false };
    const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (jsonFiles.length > 0) return { path: join(dir, jsonFiles[0]), isXml: false };
    return null;
  }

  // Mochawesome (default)
  const merged = join(dir, "mochawesome.json");
  if (existsSync(merged)) return { path: merged, isXml: false };
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.length > 0 ? { path: join(dir, files[0]), isXml: false } : null;
}

function findFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(ext)) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

async function upload(opts: UploadOptions): Promise<void> {
  const reportFile = findReportFile(opts.reportDir, opts.reporter);

  if (!reportFile) {
    console.error(`No report files found in ${opts.reportDir} for reporter "${opts.reporter}"`);
    process.exit(1);
  }

  console.log(`Found ${opts.reporter} report: ${reportFile.path}`);

  // JUnit reports are XML strings passed as-is; JSON reports are parsed
  const fileContent = readFileSync(reportFile.path, "utf-8");
  const raw = reportFile.isXml ? fileContent : JSON.parse(fileContent);
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

  const screenshots = findFiles(opts.screenshotsDir, ".png");
  const videos = findFiles(opts.videosDir, ".mp4");

  if (screenshots.length > 0 || videos.length > 0) {
    console.log(`Found ${screenshots.length} screenshot(s), ${videos.length} video(s)`);
    await uploadMultipart(payload, screenshots, videos);
  } else {
    console.log("No screenshots or videos found, uploading JSON only");
    await uploadJson(payload);
  }
}

async function uploadJson(payload: object): Promise<void> {
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

async function uploadMultipart(payload: object, screenshots: string[], videos: string[]): Promise<void> {
  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));

  for (const file of screenshots) {
    const data = readFileSync(file);
    const blob = new Blob([data], { type: "image/png" });
    formData.append("screenshots", blob, basename(file));
  }

  for (const file of videos) {
    const data = readFileSync(file);
    const blob = new Blob([data], { type: "video/mp4" });
    formData.append("videos", blob, basename(file));
  }

  const res = await fetch(`${API_URL}/runs/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Upload failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const result = await res.json();
  console.log(`Uploaded run #${(result as { id: number }).id} with artifacts to ${API_URL}`);
}

const opts = parseArgs();
upload(opts);
