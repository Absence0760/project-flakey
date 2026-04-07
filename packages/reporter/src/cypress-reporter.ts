/**
 * Cypress reporter for Flakey.
 *
 * cypress.config.ts:
 *   reporter: '@flakey/reporter/cypress',
 *   reporterOptions: {
 *     url: 'http://localhost:3000',
 *     apiKey: process.env.FLAKEY_API_KEY,
 *     suite: 'my-project',
 *   },
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";

// ---- Types (inlined to keep CJS build self-contained) ----

interface ReporterOptions {
  url: string;
  apiKey: string;
  suite: string;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
  screenshotsDir?: string;
  videosDir?: string;
  snapshotsDir?: string;
}

interface NormalizedRun {
  meta: { suite_name: string; branch: string; commit_sha: string; ci_run_id: string; started_at: string; finished_at: string; reporter: string };
  stats: { total: number; passed: number; failed: number; skipped: number; pending: number; duration_ms: number };
  specs: NormalizedSpec[];
}

interface NormalizedSpec {
  file_path: string;
  title: string;
  stats: { total: number; passed: number; failed: number; skipped: number; duration_ms: number };
  tests: NormalizedTest[];
}

interface NormalizedTest {
  title: string;
  full_title: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration_ms: number;
  error?: { message: string; stack?: string };
  screenshot_paths: string[];
  video_path?: string;
}

// ---- API Client (inlined) ----

function findFiles(dir: string | undefined, exts: string[]): string[] {
  if (!dir || !existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (exts.some((ext) => entry.endsWith(ext))) results.push(full);
      } catch {}
    }
  }
  walk(dir);
  return results;
}

async function postRunWithArtifacts(
  url: string,
  apiKey: string,
  run: NormalizedRun,
  artifactDirs: { screenshotsDir?: string; videosDir?: string; snapshotsDir?: string }
): Promise<{ id: number }> {
  const screenshots = findFiles(artifactDirs.screenshotsDir, [".png"]);
  const snapshots = findFiles(artifactDirs.snapshotsDir, [".json.gz"]);
  const videos = findFiles(artifactDirs.videosDir, [".mp4", ".webm"]);

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };

  if (screenshots.length === 0 && snapshots.length === 0 && videos.length === 0) {
    const res = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(run),
    });
    if (!res.ok) throw new Error(`Flakey API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{ id: number }>;
  }

  const formData = new FormData();
  formData.append("payload", JSON.stringify(run));

  for (const file of screenshots) {
    formData.append("screenshots", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
  }
  for (const file of videos) {
    const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
    formData.append("videos", new Blob([readFileSync(file)], { type }), basename(file));
  }
  for (const file of snapshots) {
    formData.append("snapshots", new Blob([readFileSync(file)], { type: "application/gzip" }), basename(file));
  }

  const res = await fetch(`${url}/runs/upload`, { method: "POST", headers, body: formData });
  if (!res.ok) throw new Error(`Flakey API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ id: number }>;
}

// ---- Mocha types ----

interface MochaRunner {
  on(event: string, fn: (...args: any[]) => void): void;
  suite: MochaSuite;
}

interface MochaSuite {
  title: string;
  file?: string;
  parent?: MochaSuite;
  suites: MochaSuite[];
}

interface MochaTest {
  title: string;
  fullTitle(): string;
  file?: string;
  parent?: MochaSuite;
  duration?: number;
  state?: string;
  pending?: boolean;
  err?: { message: string; stack?: string };
}

function getSpecFile(test: MochaTest): string {
  let suite: MochaSuite | undefined = test.parent;
  while (suite) {
    if (suite.file) return suite.file;
    suite = suite.parent;
  }
  return test.file ?? "unknown";
}

function getSpecTitle(test: MochaTest): string {
  let suite: MochaSuite | undefined = test.parent;
  let topSuite = suite;
  while (suite?.parent?.title) {
    topSuite = suite;
    suite = suite.parent;
  }
  return topSuite?.title ?? "unknown";
}

// ---- Reporter ----

class FlakeyCypressReporter {
  private options: ReporterOptions;
  private startedAt: Date;
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();

  constructor(runner: MochaRunner, options: { reporterOptions: ReporterOptions }) {
    const opts = options.reporterOptions;
    this.options = opts;
    this.startedAt = new Date();

    runner.on("pass", (test: MochaTest) => this.addTest(test, "passed"));
    runner.on("fail", (test: MochaTest, err: Error) => this.addTest(test, "failed", err));
    runner.on("pending", (test: MochaTest) => this.addTest(test, "skipped"));

    runner.on("end", () => {
      this.flush();
    });
  }

  private addTest(test: MochaTest, status: NormalizedTest["status"], err?: Error) {
    const filePath = getSpecFile(test);
    const specTitle = getSpecTitle(test);

    if (!this.specMap.has(filePath)) {
      this.specMap.set(filePath, {
        spec: {
          file_path: filePath,
          title: specTitle,
          stats: { total: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0 },
          tests: [],
        },
        tests: [],
      });
    }

    const entry = this.specMap.get(filePath)!;
    const duration = test.duration ?? 0;

    const normalizedTest: NormalizedTest = {
      title: test.title,
      full_title: test.fullTitle(),
      status,
      duration_ms: duration,
      screenshot_paths: [],
    };

    if (err || test.err) {
      const e = err ?? test.err!;
      normalizedTest.error = { message: e.message, stack: e.stack };
    }

    entry.tests.push(normalizedTest);
    entry.spec.stats.total++;
    entry.spec.stats.duration_ms += duration;
    if (status === "passed") entry.spec.stats.passed++;
    else if (status === "failed") entry.spec.stats.failed++;
    else entry.spec.stats.skipped++;
  }

  private flush() {
    const specs: NormalizedSpec[] = [];
    let total = 0, passed = 0, failed = 0, skipped = 0, duration = 0;

    for (const { spec, tests } of this.specMap.values()) {
      spec.tests = tests;
      specs.push(spec);
      total += spec.stats.total;
      passed += spec.stats.passed;
      failed += spec.stats.failed;
      skipped += spec.stats.skipped;
      duration += spec.stats.duration_ms;
    }

    const run: NormalizedRun = {
      meta: {
        suite_name: this.options.suite,
        branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
        commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
        ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
        started_at: this.startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "cypress",
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    const url = this.options.url.replace(/\/$/, "");

    postRunWithArtifacts(url, this.options.apiKey, run, {
      screenshotsDir: this.options.screenshotsDir ?? "cypress/screenshots",
      videosDir: this.options.videosDir ?? "cypress/videos",
      snapshotsDir: this.options.snapshotsDir ?? "cypress/snapshots",
    }).then((result) => {
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${url}`);
    }).catch((err) => {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    });
  }
}

module.exports = FlakeyCypressReporter;
