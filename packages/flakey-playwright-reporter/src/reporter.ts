/**
 * Playwright reporter for Flakey.
 *
 * playwright.config.ts:
 *   reporter: [
 *     ['@flakeytesting/playwright-reporter', {
 *       url: 'http://localhost:3000',
 *       apiKey: process.env.FLAKEY_API_KEY,
 *       suite: 'my-project',
 *     }]
 *   ],
 */

import type { ReporterOptions, NormalizedRun, NormalizedSpec, NormalizedTest } from "@flakeytesting/core";
import { ApiClient } from "@flakeytesting/core";
import { parseTrace } from "@flakeytesting/playwright-snapshots";

// Playwright reporter types — we define them inline to avoid requiring
// @playwright/test as a runtime dependency
interface PlaywrightTestCase {
  title: string;
  titlePath(): string[];
  location: { file: string; line: number; column: number };
  parent: { title: string; location?: { file: string } };
  retries: number;
}

interface PlaywrightTestResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  retry: number;
  error?: { message?: string; stack?: string };
  attachments: { name: string; path?: string; contentType: string }[];
}

interface PlaywrightFullResult {
  status: "passed" | "failed" | "timedout" | "interrupted";
}

export default class FlakeyPlaywrightReporter {
  private client: ApiClient;
  private options: ReporterOptions;
  private startedAt = new Date();
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();
  private allScreenshots: string[] = [];
  private allVideos: string[] = [];
  private allSnapshots: string[] = [];
  private traceMap = new Map<string, { tracePath: string; testTitle: string; specFile: string }>();

  constructor(options: ReporterOptions) {
    this.options = options;
    this.client = new ApiClient(options);
  }

  onTestEnd(test: PlaywrightTestCase, result: PlaywrightTestResult) {
    // Skip non-final retry attempts to avoid inflating counts.
    // result.retry is 0-based; test.retries is the configured max.
    if (result.status === "failed" && result.retry < test.retries) return;

    const filePath = test.location.file;
    const specTitle = test.parent.title || filePath;

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

    const status: NormalizedTest["status"] =
      result.status === "passed" ? "passed" :
      result.status === "failed" || result.status === "timedOut" ? "failed" :
      "skipped";

    // Print result to terminal as it happens
    const icon = status === "passed" ? "✓" : status === "failed" ? "✗" : "-";
    const errMsg = (result.error?.message ?? "").split("\n")[0];
    process.stdout.write(`  ${icon} ${test.title} (${result.duration}ms)\n`);
    if (status === "failed" && errMsg) {
      process.stdout.write(`    ${errMsg}\n`);
    }

    const titlePath = test.titlePath();
    const fullTitle = titlePath.filter(Boolean).join(" > ");

    const screenshots = result.attachments
      .filter((a) => a.contentType.startsWith("image/") && a.path)
      .map((a) => a.path!);

    const videos = result.attachments
      .filter((a) => a.contentType.startsWith("video/") && a.path)
      .map((a) => a.path!);

    // Collect all attachment file paths for upload
    this.allScreenshots.push(...screenshots);
    this.allVideos.push(...videos);

    // Collect trace files for snapshot extraction
    const traces = result.attachments
      .filter((a) => a.contentType === "application/zip" && a.path)
      .map((a) => a.path!);

    if (traces.length > 0) {
      this.traceMap.set(`${filePath}::${test.title}`, {
        tracePath: traces[0],
        testTitle: test.title,
        specFile: filePath,
      });
    }

    const normalizedTest: NormalizedTest = {
      title: test.title,
      full_title: fullTitle,
      status,
      duration_ms: result.duration,
      screenshot_paths: screenshots,
      video_path: videos[0],
    };

    if (result.error) {
      normalizedTest.error = {
        message: result.error.message ?? "Unknown error",
        stack: result.error.stack,
      };
    }

    entry.tests.push(normalizedTest);
    entry.spec.stats.total++;
    entry.spec.stats.duration_ms += result.duration;
    if (status === "passed") entry.spec.stats.passed++;
    else if (status === "failed") entry.spec.stats.failed++;
    else entry.spec.stats.skipped++;
  }

  async onEnd(_result: PlaywrightFullResult) {
    const specs: NormalizedSpec[] = [];
    let total = 0, passed = 0, failed = 0, skipped = 0, duration = 0;

    // Parse traces to extract command logs and snapshots
    const { mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { gzipSync } = await import("zlib");
    const { writeFileSync } = await import("fs");
    const snapshotsDir = join(process.cwd(), "playwright-snapshots");

    for (const { spec, tests } of this.specMap.values()) {
      for (const test of tests) {
        const key = `${spec.file_path}::${test.title}`;
        const traceInfo = this.traceMap.get(key);
        if (traceInfo) {
          try {
            const { commandLog, snapshotBundle } = parseTrace(
              traceInfo.tracePath,
              traceInfo.testTitle,
              traceInfo.specFile
            );
            if (commandLog.length > 0) {
              test.command_log = commandLog;
            }
            if (snapshotBundle && snapshotBundle.steps.length > 0) {
              mkdirSync(snapshotsDir, { recursive: true });
              const safeName = test.title.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "-").slice(0, 100);
              const safeSpec = spec.file_path.replace(/[^a-zA-Z0-9_\-./]/g, "").replace(/\//g, "__");
              const fileName = `${safeSpec}--${safeName}.json.gz`;
              const filePath = join(snapshotsDir, fileName);
              writeFileSync(filePath, gzipSync(Buffer.from(JSON.stringify(snapshotBundle))));
              this.allSnapshots.push(filePath);
              console.log(`  [flakey-snapshots] Parsed ${snapshotBundle.steps.length} steps from trace → ${fileName}`);
            }
          } catch (err: any) {
            console.warn(`  [flakey] Failed to parse trace for "${test.title}": ${err.message}`);
          }
        }
      }
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
        branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "",
        commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
        ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
        started_at: this.startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "playwright",
        ...(this.options.release || process.env.FLAKEY_RELEASE
          ? { release: (this.options.release ?? process.env.FLAKEY_RELEASE)! }
          : {}),
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    try {
      const result = await this.client.postRunWithFiles(run, {
        screenshots: this.allScreenshots,
        videos: this.allVideos,
        snapshots: this.allSnapshots,
      });
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${this.options.url}`);
    } catch (err: any) {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    }
  }
}
