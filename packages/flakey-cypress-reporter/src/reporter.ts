/**
 * Cypress reporter for Flakey.
 *
 * cypress.config.ts:
 *   import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin";
 *   export default defineConfig({
 *     reporter: "@flakeytesting/cypress-reporter",
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
import { execSync } from "child_process";

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

// ---- Temp directories ----
//
// Buffer dir is scoped by the numeric live-run-id. The Mocha reporter and
// the plugin (setupNodeEvents) live in different processes whose PIDs don't
// always line up — Cypress 15 inserts an intermediate process layer between
// setupNodeEvents and the Mocha reporter, so `process.ppid` here is not the
// plugin's pid. We walk our own ancestor chain looking for a matching
// live-run-id file written by live-reporter under every ancestor's pid.
// The nearest shared ancestor wins, usually the cypress-CLI pid.

const FLAKEY_BASE_DIR = join(tmpdir(), "flakey-reporter");

function getAncestorPids(startPid: number, maxDepth = 12): number[] {
  const chain = [startPid];
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const ppid = Number(out);
      if (!ppid || ppid === 1 || ppid === pid) break;
      chain.push(ppid);
      pid = ppid;
    } catch {
      break;
    }
  }
  return chain;
}

function readLiveRunId(): number {
  const fromEnv = Number(process.env.FLAKEY_LIVE_RUN_ID);
  if (fromEnv) return fromEnv;
  for (const pid of getAncestorPids(process.pid)) {
    try {
      const id = Number(readFileSync(join(FLAKEY_BASE_DIR, `live-run-id-${pid}`), "utf8").trim());
      if (id) return id;
    } catch { /* try next */ }
  }
  return 0;
}

function getBufferDir(): string {
  const id = readLiveRunId();
  return id ? join(FLAKEY_BASE_DIR, `run-${id}`) : FLAKEY_BASE_DIR;
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

// ---- Reporter (Mocha) — buffers results per spec to temp files ----

class FlakeyCypressReporter {
  private options: ReporterOptions;
  private specMap = new Map<string, { spec: NormalizedSpec; tests: NormalizedTest[] }>();

  constructor(runner: MochaRunner, options: { reporterOptions: ReporterOptions }) {
    this.options = options.reporterOptions ?? ({} as ReporterOptions);

    runner.on("test", (test: MochaTest) => this.onTestStart(test));
    runner.on("pass", (test: MochaTest) => this.addTest(test, "passed"));
    runner.on("fail", (test: MochaTest, err: Error) => this.addTest(test, "failed", err));
    runner.on("pending", (test: MochaTest) => this.addTest(test, "skipped"));

    runner.on("end", () => {
      this.saveToTmp();
    });
  }

  /** Send a live event to the backend (fire-and-forget). Only fires when a live run is active. */
  private sendLiveEvent(event: {
    type: string;
    test?: string;
    spec?: string;
    status?: string;
    duration_ms?: number;
    error?: string;
  }): void {
    const runId = readLiveRunId();
    if (!runId || !this.options.url || !this.options.apiKey) return;

    const url = this.options.url.replace(/\/$/, "");
    fetch(`${url}/live/${runId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify([{ ...event, timestamp: Date.now() }]),
    }).catch(() => {}); // best-effort, never throws
  }

  private onTestStart(test: MochaTest): void {
    this.sendLiveEvent({
      type: "test.started",
      test: test.fullTitle(),
      spec: getSpecFile(test),
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

    // Print result to terminal as it happens
    const icon = status === "passed" ? "✓" : status === "failed" ? "✗" : "-";
    const errMsg = (err?.message ?? test.err?.message ?? "").split("\n")[0];
    process.stdout.write(`    ${icon} ${test.title} (${duration}ms)\n`);
    if (status === "failed" && errMsg) {
      process.stdout.write(`      ${errMsg}\n`);
    }

    // Stream result to live backend as it happens
    const eventType = status === "passed" ? "test.passed"
      : status === "failed" ? "test.failed"
      : "test.skipped";
    this.sendLiveEvent({
      type: eventType,
      test: test.fullTitle(),
      spec: filePath,
      status,
      duration_ms: duration,
      error: status === "failed" ? (err?.message ?? test.err?.message) : undefined,
    });

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
    const dir = getBufferDir();
    mkdirSync(dir, { recursive: true });

    for (const { spec, tests } of this.specMap.values()) {
      spec.tests = tests;
      const safeName = spec.file_path.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
      const filePath = join(dir, `${safeName}_${Date.now()}.json`);
      writeFileSync(filePath, JSON.stringify(spec));
    }
  }
}

module.exports = FlakeyCypressReporter;
