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
  file?: string;
  tests?: MochawesomeTest[];
  suites?: MochawesomeSuite[];
}

interface MochawesomeResult {
  suites?: MochawesomeSuite;
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

function flattenTests(suite: MochawesomeSuite, prefix: string = ""): NormalizedTest[] {
  const tests: NormalizedTest[] = [];
  const suiteTitle = prefix ? `${prefix} > ${suite.title ?? ""}` : (suite.title ?? "");

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
    tests.push(...flattenTests(child, suiteTitle));
  }

  return tests;
}

export function parseMochawesome(
  raw: MochawesomeReport,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const stats = raw.stats ?? {};

  const specs: NormalizedSpec[] = (raw.results ?? []).map((result) => {
    const suite = result.suites ?? { tests: [], suites: [] };
    const tests = flattenTests(suite);
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;

    return {
      file_path: suite.file ?? "",
      title: suite.title ?? suite.file ?? "",
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
