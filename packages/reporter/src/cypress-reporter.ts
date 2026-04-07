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

import type { ReporterOptions, NormalizedRun, NormalizedSpec, NormalizedTest } from "./schema.js";
import { ApiClient } from "./api-client.js";

// Cypress uses Mocha — we get Runner, Suite, Test types from Mocha
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
  // Walk up to the top-level suite (child of root)
  let suite: MochaSuite | undefined = test.parent;
  let topSuite = suite;
  while (suite?.parent?.title) {
    topSuite = suite;
    suite = suite.parent;
  }
  return topSuite?.title ?? "unknown";
}

class FlakeyCypressReporter {
  private client: ApiClient;
  private options: ReporterOptions;
  private startedAt: Date;
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();

  constructor(runner: MochaRunner, options: { reporterOptions: ReporterOptions }) {
    const opts = options.reporterOptions;
    this.options = opts;
    this.client = new ApiClient(opts);
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
    const key = filePath;

    if (!this.specMap.has(key)) {
      this.specMap.set(key, {
        spec: {
          file_path: filePath,
          title: specTitle,
          stats: { total: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0 },
          tests: [],
        },
        tests: [],
      });
    }

    const entry = this.specMap.get(key)!;
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
      normalizedTest.error = {
        message: e.message,
        stack: e.stack,
      };
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

    this.client.postRunWithArtifacts(run, {
      screenshotsDir: this.options.screenshotsDir ?? "cypress/screenshots",
      videosDir: this.options.videosDir ?? "cypress/videos",
      snapshotsDir: this.options.snapshotsDir ?? "cypress/snapshots",
    }).then((result) => {
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${this.options.url}`);
    }).catch((err) => {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    });
  }
}

// Cypress requires CommonJS module.exports
export default FlakeyCypressReporter;
if (typeof module !== "undefined") {
  module.exports = FlakeyCypressReporter;
}
