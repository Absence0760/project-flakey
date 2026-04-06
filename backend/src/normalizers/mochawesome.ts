import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

interface MochawesomeTest {
  title?: string;
  fullTitle?: string;
  pass?: boolean;
  fail?: boolean;
  pending?: boolean;
  skipped?: boolean;
  duration?: number;
  err?: { message?: string; estack?: string };
}

interface MochawesomeSuite {
  title?: string;
  fullFile?: string;
  file?: string;
  tests?: MochawesomeTest[];
  suites?: MochawesomeSuite[];
}

interface MochawesomeResult {
  file?: string;
  fullFile?: string;
  title?: string;
  suites?: MochawesomeSuite[];
  tests?: MochawesomeTest[];
}

interface MochawesomeReport {
  stats?: {
    start?: string;
    end?: string;
    passes?: number;
    failures?: number;
    pending?: number;
    skipped?: number;
    tests?: number;
    duration?: number;
  };
  results?: MochawesomeResult[];
}

function getStatus(test: MochawesomeTest): NormalizedTest["status"] {
  if (test.pass) return "passed";
  if (test.fail) return "failed";
  if (test.pending) return "pending";
  return "skipped";
}

function collectTests(suite: MochawesomeSuite, parentTitle: string = ""): NormalizedTest[] {
  const tests: NormalizedTest[] = [];
  const suiteTitle = parentTitle
    ? `${parentTitle} > ${suite.title ?? ""}`
    : (suite.title ?? "");

  for (const test of suite.tests ?? []) {
    tests.push({
      title: test.title ?? "",
      full_title: test.fullTitle ?? `${suiteTitle} > ${test.title ?? ""}`,
      status: getStatus(test),
      duration_ms: test.duration ?? 0,
      error: test.err?.message
        ? { message: test.err.message, stack: test.err.estack }
        : undefined,
      screenshot_paths: [],
      video_path: undefined,
    });
  }

  for (const child of suite.suites ?? []) {
    tests.push(...collectTests(child, suiteTitle));
  }

  return tests;
}

export function parseMochawesome(
  raw: MochawesomeReport,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const stats = raw.stats ?? {};

  const specs: NormalizedSpec[] = (raw.results ?? []).map((result) => {
    // Collect all tests from all top-level suites in this result
    const tests: NormalizedTest[] = [];

    // Tests directly on the result (rare but possible)
    for (const test of result.tests ?? []) {
      tests.push({
        title: test.title ?? "",
        full_title: test.fullTitle ?? (test.title ?? ""),
        status: getStatus(test),
        duration_ms: test.duration ?? 0,
        error: test.err?.message
          ? { message: test.err.message, stack: test.err.estack }
          : undefined,
        screenshot_paths: [],
        video_path: undefined,
      });
    }

    // Walk all suites (this is where tests actually live)
    for (const suite of result.suites ?? []) {
      tests.push(...collectTests(suite));
    }

    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;
    const filePath = result.file ?? result.fullFile ?? "";

    return {
      file_path: filePath,
      title: result.title || filePath,
      stats: {
        total: tests.length,
        passed,
        failed,
        skipped,
        duration_ms: tests.reduce((sum, t) => sum + t.duration_ms, 0),
      },
      tests,
    };
  });

  return {
    meta: {
      ...meta,
      started_at: meta.started_at || stats.start || new Date().toISOString(),
      finished_at: meta.finished_at || stats.end || new Date().toISOString(),
      reporter: "mochawesome",
    },
    stats: {
      total: stats.tests ?? 0,
      passed: stats.passes ?? 0,
      failed: stats.failures ?? 0,
      skipped: stats.skipped ?? 0,
      pending: stats.pending ?? 0,
      duration_ms: stats.duration ?? 0,
    },
    specs,
  };
}
