/**
 * Playwright reporter for Flakey.
 *
 * playwright.config.ts:
 *   reporter: [
 *     ['@flakey/reporter/playwright', {
 *       url: 'http://localhost:3000',
 *       apiKey: process.env.FLAKEY_API_KEY,
 *       suite: 'my-project',
 *     }]
 *   ],
 */

import type { ReporterOptions, NormalizedRun, NormalizedSpec, NormalizedTest } from "./schema.js";
import { ApiClient } from "./api-client.js";

// Playwright reporter types — we define them inline to avoid requiring
// @playwright/test as a runtime dependency
interface PlaywrightTestCase {
  title: string;
  titlePath(): string[];
  location: { file: string; line: number; column: number };
  parent: { title: string; location?: { file: string } };
}

interface PlaywrightTestResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
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

  constructor(options: ReporterOptions) {
    this.options = options;
    this.client = new ApiClient(options);
  }

  onTestEnd(test: PlaywrightTestCase, result: PlaywrightTestResult) {
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
        branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
        commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
        ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
        started_at: this.startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "playwright",
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    try {
      const result = await this.client.postRunWithFiles(run, {
        screenshots: this.allScreenshots,
        videos: this.allVideos,
        snapshots: [],
      });
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${this.options.url}`);
    } catch (err: any) {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    }
  }
}
