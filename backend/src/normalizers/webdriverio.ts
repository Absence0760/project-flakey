import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

/**
 * WebdriverIO JSON reporter output format.
 * Generated via: @wdio/json-reporter or custom JSON output.
 *
 * This normalizer handles the standard WDIO JSON reporter format.
 * The direct reporter plugin (flakey-webdriverio-reporter) bypasses this
 * by building NormalizedRun directly, but this handles CLI/curl uploads.
 */

interface WdioTestResult {
  name: string;
  fullTitle?: string;
  title?: string;
  state: "passed" | "failed" | "skipped" | "pending";
  duration: number;
  start?: string;
  end?: string;
  error?: {
    message?: string;
    stack?: string;
    type?: string;
  };
  _retries?: number;
  uid?: string;
}

interface WdioSuiteResult {
  name?: string;
  title?: string;
  fullTitle?: string;
  file?: string;
  tests: WdioTestResult[];
  suites?: WdioSuiteResult[];
  start?: string;
  end?: string;
  duration?: number;
  hooks?: WdioTestResult[];
}

interface WdioSpecResult {
  filename?: string;
  file?: string;
  suites: WdioSuiteResult[];
  start?: string;
  end?: string;
  duration?: number;
}

interface WdioReport {
  // Top-level can be an array of spec results or a single result object
  specs?: WdioSpecResult[];
  suites?: WdioSuiteResult[];
  // Alternative flat format
  start?: string;
  end?: string;
  state?: { passed: number; failed: number; skipped: number };
}

function mapStatus(state: string): NormalizedTest["status"] {
  switch (state) {
    case "passed": return "passed";
    case "failed": return "failed";
    case "pending": return "pending";
    case "skipped": return "skipped";
    default: return "skipped";
  }
}

function collectTests(suite: WdioSuiteResult, parentTitle = ""): NormalizedTest[] {
  const tests: NormalizedTest[] = [];
  const suiteName = suite.name || suite.title || "";
  const fullPrefix = parentTitle ? `${parentTitle} > ${suiteName}` : suiteName;

  for (const test of suite.tests ?? []) {
    const title = test.name || test.title || "Unknown test";
    const status = mapStatus(test.state);

    let error: NormalizedTest["error"] | undefined;
    if (test.error) {
      error = {
        message: (test.error.message ?? "Unknown error").slice(0, 500),
        stack: test.error.stack?.slice(0, 2000),
      };
    }

    const metadata: Record<string, unknown> = {};
    if (test.error?.type) metadata.error_type = test.error.type;
    if (test._retries && test._retries > 0) metadata.retries = test._retries;

    tests.push({
      title,
      full_title: test.fullTitle || `${fullPrefix} > ${title}`,
      status,
      duration_ms: test.duration ?? 0,
      error,
      screenshot_paths: [],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  // Recurse into nested suites
  for (const nested of suite.suites ?? []) {
    tests.push(...collectTests(nested, fullPrefix));
  }

  return tests;
}

function parseSuiteToSpec(suite: WdioSuiteResult, filePath: string): NormalizedSpec {
  const tests = collectTests(suite);

  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;

  return {
    file_path: filePath,
    title: suite.name || suite.title || filePath.split("/").pop() || filePath,
    stats: {
      total: tests.length,
      passed,
      failed,
      skipped,
      duration_ms: suite.duration ?? tests.reduce((s, t) => s + t.duration_ms, 0),
    },
    tests,
  };
}

export function parseWebdriverIO(
  raw: unknown,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const report = raw as WdioReport;
  const specs: NormalizedSpec[] = [];

  if (report.specs && report.specs.length > 0) {
    // Standard format: array of spec results with nested suites
    for (const specResult of report.specs) {
      const filePath = specResult.filename || specResult.file || "unknown";
      for (const suite of specResult.suites) {
        specs.push(parseSuiteToSpec(suite, filePath));
      }
    }
  } else if (report.suites && report.suites.length > 0) {
    // Flat format: suites at top level
    for (const suite of report.suites) {
      const filePath = suite.file || suite.name || "unknown";
      specs.push(parseSuiteToSpec(suite, filePath));
    }
  }

  const total = specs.reduce((s, sp) => s + sp.stats.total, 0);
  const passed = specs.reduce((s, sp) => s + sp.stats.passed, 0);
  const failed = specs.reduce((s, sp) => s + sp.stats.failed, 0);
  const skipped = specs.reduce((s, sp) => s + sp.stats.skipped, 0);
  const durationMs = specs.reduce((s, sp) => s + sp.stats.duration_ms, 0);

  return {
    meta: {
      ...meta,
      started_at: meta.started_at || report.start || new Date().toISOString(),
      finished_at: meta.finished_at || report.end || new Date().toISOString(),
      reporter: "webdriverio",
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
