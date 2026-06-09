#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename, dirname, isAbsolute } from "path";

// Strip trailing slashes so a configured FLAKEY_API_URL like
// "https://api.flakey.io/" doesn't produce "https://api.flakey.io//runs",
// which Express does not route (every upload 404s). Mirrors the same
// normalization ApiClient applies in @flakeytesting/core.
const API_URL = (process.env.FLAKEY_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const API_KEY = process.env.FLAKEY_API_KEY ?? "";

interface UploadOptions {
  reportDir: string;
  suiteName: string;
  branch: string;
  commitSha: string;
  ciRunId: string;
  release: string;
  environment: string;
  reporter: string;
  screenshotsDir: string;
  videosDir: string;
  snapshotsDir: string;
  apiKey: string;
}

// Exported for unit testing (src/tests/cli.test.ts). The resolution
// chain has multiple fallbacks per field and is exactly the kind of
// thing that silently regresses — pin it.
export function resolveOptions(opts: Record<string, string>): UploadOptions {
  return {
    reportDir: resolve(opts["report-dir"] ?? "cypress/reports"),
    // FLAKEY_SUITE env-var fallback so CI consumers can drop the
    // --suite flag entirely (matches the live-reporter adapters and the
    // main playwright/wdio reporters). Without it, a CI invocation that
    // sets FLAKEY_SUITE but omits --suite silently filed everything
    // under "default".
    suiteName: opts["suite"] ?? process.env.FLAKEY_SUITE ?? "default",
    // Env-var resolution chains aligned with the reporter packages.
    // GHA / Bitbucket fallbacks cover the common-CI default vars so a
    // user who runs `flakey-upload` from GitHub Actions without
    // setting BRANCH/COMMIT_SHA/CI_RUN_ID still gets meaningful values.
    branch: opts["branch"] ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
    commitSha: opts["commit"] ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
    ciRunId: opts["ci-run-id"] ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
    release: opts["release"] ?? process.env.FLAKEY_RELEASE ?? "",
    environment: opts["environment"] ?? process.env.FLAKEY_ENV ?? process.env.TEST_ENV ?? "",
    reporter: opts["reporter"] ?? "mochawesome",
    screenshotsDir: resolve(opts["screenshots-dir"] ?? "cypress/screenshots"),
    videosDir: resolve(opts["videos-dir"] ?? "cypress/videos"),
    snapshotsDir: resolve(opts["snapshots-dir"] ?? "cypress/snapshots"),
    apiKey: opts["api-key"] ?? API_KEY,
  };
}

// Exported for unit testing (src/tests/cli.test.ts).
//
// Parse `--flag value` pairs into a map. A flag whose next token is itself
// a `--flag` (i.e. the value was omitted) is recorded as "" rather than
// swallowing the following flag as its value — otherwise
// `--report-dir --suite x` would set reportDir="--suite" and drop --suite
// entirely, silently filing the run under the wrong directory/suite.
export function parseFlags(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "";
      }
    }
  }
  return opts;
}

function parseArgs(): UploadOptions {
  return resolveOptions(parseFlags(process.argv.slice(2)));
}

// The reporters whose report shape findReportFile knows how to locate. Any
// other value (a typo, or a flag whose value got eaten) would otherwise fall
// through to the mochawesome branch and silently grab any .json in the dir.
export const KNOWN_REPORTERS = ["mochawesome", "junit", "playwright"] as const;

// Exported for unit testing (src/tests/cli.test.ts).
export function findReportFile(dir: string, reporter: string): { path: string; isXml: boolean } | null {
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

// Exported for unit testing (src/tests/cli.test.ts).
export function findFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(ext)) {
          results.push(full);
        }
      } catch {
        // Skip inaccessible entries (broken symlinks, permission errors)
      }
    }
  }

  walk(dir);
  return results;
}

async function upload(opts: UploadOptions): Promise<void> {
  // Reject an unknown reporter up front rather than letting it fall through to
  // the mochawesome path and silently parse some arbitrary .json as if it were
  // a mochawesome report.
  if (!(KNOWN_REPORTERS as readonly string[]).includes(opts.reporter)) {
    console.error(`Unknown reporter "${opts.reporter}". Valid reporters: ${KNOWN_REPORTERS.join(", ")}`);
    process.exit(1);
  }

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
      ...(opts.release ? { release: opts.release } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
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

  // Snapshot files
  const snapshots = findFiles(opts.snapshotsDir, ".json.gz");

  if (screenshots.length > 0 || videos.length > 0 || snapshots.length > 0) {
    console.log(`Found ${screenshots.length} screenshot(s), ${videos.length} video(s), ${snapshots.length} snapshot(s)`);
    await uploadMultipart(payload, screenshots, videos, snapshots, opts.apiKey);
  } else {
    console.log("No screenshots or videos found, uploading JSON only");
    await uploadJson(payload, opts.apiKey);
  }
}

/**
 * Walk the Playwright JSON report and extract all attachment file paths.
 * Paths in the report can be absolute or relative to the report directory.
 */
export function extractPlaywrightAttachments(report: any, reportDir: string): { screenshots: string[]; videos: string[] } {
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

// Exported for unit testing (src/tests/cli.test.ts).
export function authHeaders(apiKey: string): Record<string, string> {
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

async function uploadMultipart(payload: object, screenshots: string[], videos: string[], snapshots: string[], apiKey: string): Promise<void> {
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

  for (const file of snapshots) {
    const data = readFileSync(file);
    const blob = new Blob([data], { type: "application/gzip" });
    formData.append("snapshots", blob, basename(file));
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

// ─── Subcommand dispatch ──────────────────────────────────────────────────
// Usage:
//   flakey-cli [upload] --suite X --report-dir Y ...    (backwards compatible)
//   flakey-cli coverage --run-id 42 --file coverage-summary.json
//   flakey-cli a11y     --run-id 42 --file axe-results.json [--url /]
//   flakey-cli visual   --run-id 42 --file visual-manifest.json
//   flakey-cli ui-coverage --suite X --file visits.json

function parseSubArgs(args: string[]): Record<string, string> {
  return parseFlags(args);
}

async function postJSON(path: string, body: unknown, apiKey: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`POST ${path} failed (${res.status}): ${text}`);
    process.exit(1);
  }
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

/** Normalize an Istanbul coverage-summary.json into the Flakey coverage schema. */
// Exported for unit testing (src/tests/cli.test.ts).
export function normalizeIstanbulSummary(report: any): {
  lines_pct: number;
  branches_pct: number;
  functions_pct: number;
  statements_pct: number;
  lines_covered: number;
  lines_total: number;
} {
  const total = report.total ?? report;
  return {
    lines_pct: Number(total.lines?.pct ?? 0),
    branches_pct: Number(total.branches?.pct ?? 0),
    functions_pct: Number(total.functions?.pct ?? 0),
    statements_pct: Number(total.statements?.pct ?? 0),
    lines_covered: Number(total.lines?.covered ?? 0),
    lines_total: Number(total.lines?.total ?? 0),
  };
}

async function uploadCoverage(args: string[]): Promise<void> {
  const opts = parseSubArgs(args);
  const runId = Number(opts["run-id"]);
  const file = opts["file"];
  const apiKey = opts["api-key"] ?? API_KEY;
  const release = opts["release"] ?? process.env.FLAKEY_RELEASE ?? "";
  if (!runId || !file) {
    console.error("Usage: flakey-cli coverage --run-id <id> --file <coverage-summary.json> [--release <version>]");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolve(file), "utf-8"));
  const payload: Record<string, unknown> = {
    run_id: runId,
    ...normalizeIstanbulSummary(raw),
  };
  if (release) payload.release = release;
  await postJSON("/coverage", payload, apiKey);
}

async function uploadA11y(args: string[]): Promise<void> {
  const opts = parseSubArgs(args);
  const runId = Number(opts["run-id"]);
  const file = opts["file"];
  const url = opts["url"];
  const apiKey = opts["api-key"] ?? API_KEY;
  if (!runId || !file) {
    console.error("Usage: flakey-cli a11y --run-id <id> --file <axe-results.json> [--url <path>]");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolve(file), "utf-8"));
  // axe-core results have shape: { violations: [...], passes: [...], incomplete: [...], url?: string }
  // Accept either a single result or an array — take the first.
  const result = Array.isArray(raw) ? raw[0] : raw;
  // An empty array (`[]`) — or a JSON `null` — yields no result object;
  // bail with a clear message instead of throwing on `result.url`.
  if (!result || typeof result !== "object") {
    console.error(`No axe-core results found in ${file}`);
    process.exit(1);
  }
  const payload = {
    run_id: runId,
    url: url ?? result.url ?? null,
    violations: result.violations ?? [],
    passes: result.passes?.length ?? 0,
    incomplete: result.incomplete?.length ?? 0,
  };
  await postJSON("/a11y", payload, apiKey);
}

async function uploadVisual(args: string[]): Promise<void> {
  const opts = parseSubArgs(args);
  const runId = Number(opts["run-id"]);
  const file = opts["file"];
  const apiKey = opts["api-key"] ?? API_KEY;
  if (!runId || !file) {
    console.error("Usage: flakey-cli visual --run-id <id> --file <visual-manifest.json>");
    console.error("Manifest format: { diffs: [{name,status,diff_pct,baseline_path,current_path,diff_path}] }");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolve(file), "utf-8"));
  const diffs = Array.isArray(raw) ? raw : raw.diffs;
  await postJSON("/visual", { run_id: runId, diffs }, apiKey);
}

async function uploadUiCoverage(args: string[]): Promise<void> {
  const opts = parseSubArgs(args);
  const suite = opts["suite"];
  const file = opts["file"];
  const runId = opts["run-id"] ? Number(opts["run-id"]) : null;
  const apiKey = opts["api-key"] ?? API_KEY;
  if (!suite || !file) {
    console.error("Usage: flakey-cli ui-coverage --suite <name> --file <visits.json> [--run-id <id>]");
    console.error("Visits file: [\"/route1\",\"/route2\"] or [{route_pattern:\"/x\"}]");
    process.exit(1);
  }
  const visits = JSON.parse(readFileSync(resolve(file), "utf-8"));
  await postJSON("/ui-coverage/visits", { suite_name: suite, run_id: runId, visits }, apiKey);
}

// Guard the CLI dispatch so this module can be imported by unit tests
// for resolveOptions (and any future testable helper) without firing
// the upload pipeline. The `bin` shebang invocation passes
// process.argv[1] = path-to-this-file, so when run as a CLI the guard
// is true; when imported via `await import(...)` from a test, argv[1]
// is the test runner.
const invokedAsCli =
  process.argv[1] &&
  (process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("/index.ts") ||
    process.argv[1].endsWith("/flakey-upload"));

if (invokedAsCli) {
  (async () => {
    const argv = process.argv.slice(2);
    const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
    const rest = sub ? argv.slice(1) : argv;

    switch (sub) {
      case "coverage":   await uploadCoverage(rest);   break;
      case "a11y":       await uploadA11y(rest);       break;
      case "visual":     await uploadVisual(rest);     break;
      case "ui-coverage": await uploadUiCoverage(rest); break;
      case "upload":
      case null:         await upload(parseArgs());    break;
      default:
        console.error(`Unknown subcommand: ${sub}`);
        console.error("Available: upload, coverage, a11y, visual, ui-coverage");
        process.exit(1);
    }
  })().catch((err) => {
    console.error(`flakey-upload: unexpected error — ${err?.message ?? err}`);
    process.exit(1);
  });
}
