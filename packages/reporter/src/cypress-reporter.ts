/**
 * Cypress reporter for Flakey.
 *
 * cypress.config.ts:
 *   import { flakeyReporter } from "@flakeytesting/reporter/dist/cypress-plugin.js";
 *   export default defineConfig({
 *     reporter: "@flakeytesting/reporter/dist/cypress-reporter.cjs",
 *     reporterOptions: {
 *       url: 'http://localhost:3000',
 *       apiKey: process.env.FLAKEY_API_KEY,
 *       suite: 'my-project',
 *     },
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         flakeyReporter(on, config);
 *       },
 *     },
 *   });
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

// ---- Types ----

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

// ---- Shared temp directory for buffering spec results ----

const FLAKEY_TMP_DIR = join(tmpdir(), "flakey-reporter");

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

// ---- Reporter (Mocha) — buffers results per spec to temp files ----

class FlakeyCypressReporter {
  private options: ReporterOptions;
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();

  constructor(runner: MochaRunner, options: { reporterOptions: ReporterOptions }) {
    this.options = options.reporterOptions;

    runner.on("pass", (test: MochaTest) => this.addTest(test, "passed"));
    runner.on("fail", (test: MochaTest, err: Error) => this.addTest(test, "failed", err));
    runner.on("pending", (test: MochaTest) => this.addTest(test, "skipped"));

    runner.on("end", () => {
      this.saveToTmp();
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

  private saveToTmp() {
    mkdirSync(FLAKEY_TMP_DIR, { recursive: true });

    for (const { spec, tests } of this.specMap.values()) {
      spec.tests = tests;
      const safeName = spec.file_path.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
      const filePath = join(FLAKEY_TMP_DIR, `${safeName}_${Date.now()}.json`);
      writeFileSync(filePath, JSON.stringify(spec));
    }
  }
}

module.exports = FlakeyCypressReporter;
