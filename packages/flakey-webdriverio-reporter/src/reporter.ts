/**
 * WebdriverIO reporter for Flakey.
 *
 * wdio.conf.ts:
 *   import FlakeyReporter from "@flakeytesting/webdriverio-reporter";
 *   export const config = {
 *     reporters: [
 *       [FlakeyReporter, {
 *         url: "http://localhost:3000",
 *         apiKey: process.env.FLAKEY_API_KEY,
 *         suite: "my-project",
 *       }],
 *     ],
 *   };
 */

import WDIOReporter from "@wdio/reporter";
import type { RunnerStats, SuiteStats, TestStats } from "@wdio/reporter";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import type { ReporterOptions, NormalizedRun, NormalizedSpec, NormalizedTest } from "@flakeytesting/core";
import { ApiClient } from "@flakeytesting/core";

interface FlakeyWdioOptions extends ReporterOptions {
  screenshotsDir?: string;
  videosDir?: string;
}

export default class FlakeyWdioReporter extends WDIOReporter {
  private client: ApiClient;
  private flakeyOpts: FlakeyWdioOptions;
  private startedAt = new Date();
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();
  private activeSpec = "";

  constructor(options: any) {
    super(options);
    this.flakeyOpts = options as FlakeyWdioOptions;
    this.client = new ApiClient(this.flakeyOpts);
  }

  onRunnerStart(runner: RunnerStats) {
    this.startedAt = runner.start;
  }

  onSuiteStart(suite: SuiteStats) {
    if (suite.file) {
      this.activeSpec = suite.file;
    }
    if (!this.specMap.has(this.activeSpec) && this.activeSpec) {
      this.specMap.set(this.activeSpec, {
        spec: {
          file_path: this.activeSpec,
          title: suite.title || basename(this.activeSpec),
          stats: { total: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0 },
          tests: [],
        },
        tests: [],
      });
    }
  }

  onTestPass(test: TestStats) {
    this.addTest(test, "passed");
  }

  onTestFail(test: TestStats) {
    this.addTest(test, "failed");
  }

  onTestSkip(test: TestStats) {
    this.addTest(test, "skipped");
  }

  private addTest(test: TestStats, status: NormalizedTest["status"]) {
    const specKey = this.activeSpec;
    if (!this.specMap.has(specKey)) return;

    const entry = this.specMap.get(specKey)!;
    const duration = test.duration ?? 0;

    const normalizedTest: NormalizedTest = {
      title: test.title,
      full_title: test.fullTitle || `${entry.spec.title} > ${test.title}`,
      status,
      duration_ms: duration,
      screenshot_paths: [],
    };

    const err = (test as any).error ?? (test as any).errors?.[0];
    if (err) {
      normalizedTest.error = {
        message: err.message,
        stack: err.stack,
      };
    }

    entry.tests.push(normalizedTest);
    entry.spec.stats.total++;
    entry.spec.stats.duration_ms += duration;
    if (status === "passed") entry.spec.stats.passed++;
    else if (status === "failed") entry.spec.stats.failed++;
    else entry.spec.stats.skipped++;
  }

  async onRunnerEnd(runner: RunnerStats) {
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

    if (total === 0) return;

    const run: NormalizedRun = {
      meta: {
        suite_name: this.flakeyOpts.suite,
        branch: this.flakeyOpts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
        commit_sha: this.flakeyOpts.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
        ci_run_id: this.flakeyOpts.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
        started_at: this.startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "webdriverio",
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    const screenshotsDir = this.flakeyOpts.screenshotsDir ?? "screenshots";
    const videosDir = this.flakeyOpts.videosDir ?? "videos";

    const screenshots = findFiles(screenshotsDir, [".png"]);
    const videos = findFiles(videosDir, [".mp4", ".webm"]);

    try {
      const result = await this.client.postRunWithFiles(run, {
        screenshots,
        videos,
        snapshots: [],
      });
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${this.flakeyOpts.url}`);
    } catch (err: any) {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    }
  }
}

function findFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
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
