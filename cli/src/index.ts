#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename, dirname, isAbsolute } from "path";

const API_URL = process.env.FLAKEY_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.FLAKEY_API_KEY ?? "";

interface UploadOptions {
  reportDir: string;
  suiteName: string;
  branch: string;
  commitSha: string;
  ciRunId: string;
  reporter: string;
  screenshotsDir: string;
  videosDir: string;
  apiKey: string;
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
    apiKey: opts["api-key"] ?? API_KEY,
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

  let screenshots = findFiles(opts.screenshotsDir, ".png");
  let videos = findFiles(opts.videosDir, ".mp4");

  // For Playwright, also extract attachment paths from the report itself
  if (opts.reporter === "playwright" && !reportFile.isXml) {
    const reportDir = dirname(reportFile.path);
    const extracted = extractPlaywrightAttachments(raw, reportDir);
    screenshots = [...screenshots, ...extracted.screenshots];
    videos = [...videos, ...extracted.videos];
  }

  // Also look for .webm videos (Playwright default format)
  const webmVideos = findFiles(opts.videosDir, ".webm");
  videos = [...videos, ...webmVideos];

  if (screenshots.length > 0 || videos.length > 0) {
    console.log(`Found ${screenshots.length} screenshot(s), ${videos.length} video(s)`);
    await uploadMultipart(payload, screenshots, videos, opts.apiKey);
  } else {
    console.log("No screenshots or videos found, uploading JSON only");
    await uploadJson(payload, opts.apiKey);
  }
}

/**
 * Walk the Playwright JSON report and extract all attachment file paths.
 * Paths in the report can be absolute or relative to the report directory.
 */
function extractPlaywrightAttachments(report: any, reportDir: string): { screenshots: string[]; videos: string[] } {
  const screenshots: string[] = [];
  const videos: string[] = [];
  const seen = new Set<string>();

  function walkSuites(suites: any[]) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? []) {
            for (const att of result.attachments ?? []) {
              if (!att.path) continue;
              const fullPath = isAbsolute(att.path) ? att.path : resolve(reportDir, att.path);
              if (seen.has(fullPath) || !existsSync(fullPath)) continue;
              seen.add(fullPath);

              if (att.contentType?.startsWith("image/")) {
                screenshots.push(fullPath);
              } else if (att.contentType?.startsWith("video/")) {
                videos.push(fullPath);
              }
            }
          }
        }
      }
      if (suite.suites) walkSuites(suite.suites);
    }
  }

  walkSuites(report.suites ?? []);
  return { screenshots, videos };
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

async function uploadJson(payload: object, apiKey: string): Promise<void> {
  const res = await fetch(`${API_URL}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
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

async function uploadMultipart(payload: object, screenshots: string[], videos: string[], apiKey: string): Promise<void> {
  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));

  for (const file of screenshots) {
    const data = readFileSync(file);
    const blob = new Blob([data], { type: "image/png" });
    formData.append("screenshots", blob, basename(file));
  }

  for (const file of videos) {
    const data = readFileSync(file);
    const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
    const blob = new Blob([data], { type });
    formData.append("videos", blob, basename(file));
  }

  const res = await fetch(`${API_URL}/runs/upload`, {
    method: "POST",
    headers: authHeaders(apiKey),
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
