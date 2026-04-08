import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

/**
 * Jest JSON reporter output format.
 * Generated via: jest --json --outputFile=results.json
 * or with jest-junit for JUnit XML (handled by junit.ts).
 */

interface JestTestResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: "passed" | "failed" | "pending" | "skipped" | "todo" | "disabled";
  duration: number | null;
  failureMessages: string[];
  failureDetails: Array<{ message?: string; stack?: string }>;
  numPassingAsserts: number;
}

interface JestSuiteResult {
  testFilePath: string;
  testResults: JestTestResult[];
  numPassingTests: number;
  numFailingTests: number;
  numPendingTests: number;
  numTodoTests: number;
  perfStats: {
    start: number;
    end: number;
    runtime: number;
    slow: boolean;
  };
  testExecError?: { message: string; stack: string };
  console?: Array<{ message: string; origin: string; type: string }>;
}

interface JestReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  numTotalTestSuites: number;
  startTime: number;
  testResults: JestSuiteResult[];
  success: boolean;
  wasInterrupted: boolean;
}

function mapStatus(status: JestTestResult["status"]): NormalizedTest["status"] {
  switch (status) {
    case "passed": return "passed";
    case "failed": return "failed";
    case "pending":
    case "todo":
    case "disabled": return "pending";
    case "skipped": return "skipped";
    default: return "skipped";
  }
}

function parseTest(test: JestTestResult): NormalizedTest {
  const status = mapStatus(test.status);

  let error: NormalizedTest["error"] | undefined;
  if (test.failureMessages.length > 0) {
    const raw = test.failureMessages[0];
    // Jest failure messages often contain ANSI codes; strip them
    const clean = raw.replace(/\u001b\[[0-9;]*m/g, "");
    const firstLine = clean.split("\n")[0] || clean;
    error = {
      message: firstLine.slice(0, 500),
      stack: clean.slice(0, 2000),
    };
  }

  const metadata: Record<string, unknown> = {};
  if (test.ancestorTitles.length > 0) {
    metadata.ancestorTitles = test.ancestorTitles;
  }
  if (test.numPassingAsserts > 0) {
    metadata.numPassingAsserts = test.numPassingAsserts;
  }

  return {
    title: test.title,
    full_title: test.fullName || [...test.ancestorTitles, test.title].join(" > "),
    status,
    duration_ms: test.duration ?? 0,
    error,
    screenshot_paths: [],
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function parseSuite(suite: JestSuiteResult): NormalizedSpec {
  const tests = suite.testResults.map(parseTest);

  // If the suite itself had an exec error (e.g. syntax error), add a synthetic failed test
  if (suite.testExecError && tests.length === 0) {
    tests.push({
      title: "Suite execution error",
      full_title: `${suite.testFilePath} > Suite execution error`,
      status: "failed",
      duration_ms: 0,
      error: {
        message: suite.testExecError.message,
        stack: suite.testExecError.stack,
      },
      screenshot_paths: [],
    });
  }

  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;

  // Strip workspace root from path for cleaner display
  const filePath = suite.testFilePath.replace(/^.*?(?=src\/|tests?\/|__tests__|spec\/)/, "") || suite.testFilePath;

  const metadata: Record<string, unknown> = {};
  if (suite.console && suite.console.length > 0) {
    metadata.stdout = suite.console
      .map((c) => `[${c.type}] ${c.message}`)
      .slice(-100);
  }

  return {
    file_path: filePath,
    title: filePath.split("/").pop() ?? filePath,
    stats: {
      total: tests.length,
      passed,
      failed,
      skipped,
      duration_ms: suite.perfStats?.runtime ?? tests.reduce((s, t) => s + t.duration_ms, 0),
    },
    tests,
  };
}

export function parseJest(
  raw: unknown,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const report = raw as JestReport;
  const specs = report.testResults.map(parseSuite);

  const total = specs.reduce((s, sp) => s + sp.stats.total, 0);
  const passed = specs.reduce((s, sp) => s + sp.stats.passed, 0);
  const failed = specs.reduce((s, sp) => s + sp.stats.failed, 0);
  const skipped = specs.reduce((s, sp) => s + sp.stats.skipped, 0);
  const durationMs = specs.reduce((s, sp) => s + sp.stats.duration_ms, 0);

  const startedAt = meta.started_at || new Date(report.startTime).toISOString();

  return {
    meta: {
      ...meta,
      started_at: startedAt,
      finished_at: meta.finished_at || new Date(report.startTime + durationMs).toISOString(),
      reporter: "jest",
    },
    stats: {
      total,
      passed,
      failed,
      skipped,
      pending: specs.reduce((s, sp) =>
        s + sp.tests.filter((t) => t.status === "pending").length, 0),
      duration_ms: durationMs,
    },
    specs,
  };
}
