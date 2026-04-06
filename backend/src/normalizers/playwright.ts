import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

// Playwright JSON report format (from `npx playwright test --reporter=json`)
interface PlaywrightAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

interface PlaywrightError {
  message?: string;
  stack?: string;
  snippet?: string;
}

interface PlaywrightResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  error?: PlaywrightError;
  errors?: PlaywrightError[];
  attachments?: PlaywrightAttachment[];
  stdout?: string[];
  stderr?: string[];
}

interface PlaywrightTest {
  title: string;
  ok: boolean;
  tags?: string[];
  results: PlaywrightResult[];
  location?: { file: string; line: number; column: number };
  annotations?: { type: string; description?: string }[];
  expectedStatus?: string;
}

interface PlaywrightSuite {
  title: string;
  file?: string;
  line?: number;
  column?: number;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightSpec {
  title: string;
  ok: boolean;
  tags?: string[];
  tests: PlaywrightTest[];
  file?: string;
  line?: number;
}

interface PlaywrightReport {
  config?: {
    rootDir?: string;
  };
  suites?: PlaywrightSuite[];
  stats?: {
    startTime: string;
    duration: number;
  };
  errors?: PlaywrightError[];
}

function mapStatus(result: PlaywrightResult): NormalizedTest["status"] {
  switch (result.status) {
    case "passed": return "passed";
    case "failed": return "failed";
    case "timedOut": return "failed";
    case "skipped": return "skipped";
    case "interrupted": return "failed";
    default: return "skipped";
  }
}

function extractError(result: PlaywrightResult): NormalizedTest["error"] | undefined {
  const err = result.error || result.errors?.[0];
  if (!err) return undefined;
  return {
    message: err.message ?? "Unknown error",
    stack: err.stack,
  };
}

function extractScreenshots(result: PlaywrightResult): string[] {
  return (result.attachments ?? [])
    .filter((a) => a.contentType.startsWith("image/") && a.path)
    .map((a) => a.path!);
}

function extractVideo(result: PlaywrightResult): string | undefined {
  const video = (result.attachments ?? []).find(
    (a) => a.contentType.startsWith("video/") && a.path
  );
  return video?.path;
}

function collectFromSuite(
  suite: PlaywrightSuite,
  parentPath: string[],
): { specs: Map<string, NormalizedTest[]> } {
  const result: Map<string, NormalizedTest[]> = new Map();
  const titlePath = suite.title ? [...parentPath, suite.title] : parentPath;
  const filePath = suite.file ?? titlePath.join(" > ");

  // Process specs (Playwright "spec" = a describe/test grouping)
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      // Use the last result (retries produce multiple results)
      const lastResult = test.results[test.results.length - 1];
      if (!lastResult) continue;

      const specFile = spec.file ?? suite.file ?? filePath;
      const fullTitle = [...titlePath, spec.title].filter(Boolean).join(" > ");

      const normalized: NormalizedTest = {
        title: spec.title,
        full_title: fullTitle,
        status: mapStatus(lastResult),
        duration_ms: lastResult.duration,
        error: extractError(lastResult),
        screenshot_paths: extractScreenshots(lastResult),
        video_path: extractVideo(lastResult),
      };

      const existing = result.get(specFile) ?? [];
      existing.push(normalized);
      result.set(specFile, existing);
    }
  }

  // Recurse into child suites
  for (const child of suite.suites ?? []) {
    const childResult = collectFromSuite(child, titlePath);
    for (const [key, tests] of childResult.specs) {
      const existing = result.get(key) ?? [];
      existing.push(...tests);
      result.set(key, existing);
    }
  }

  return { specs: result };
}

export function parsePlaywright(
  raw: PlaywrightReport,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  // Collect all tests grouped by file
  const allTests = new Map<string, NormalizedTest[]>();

  for (const suite of raw.suites ?? []) {
    const { specs } = collectFromSuite(suite, []);
    for (const [file, tests] of specs) {
      const existing = allTests.get(file) ?? [];
      existing.push(...tests);
      allTests.set(file, existing);
    }
  }

  // Build normalized specs
  const specs: NormalizedSpec[] = [];
  for (const [filePath, tests] of allTests) {
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;

    specs.push({
      file_path: filePath,
      title: filePath.split("/").pop() ?? filePath,
      stats: {
        total: tests.length,
        passed,
        failed,
        skipped,
        duration_ms: tests.reduce((sum, t) => sum + t.duration_ms, 0),
      },
      tests,
    });
  }

  const total = specs.reduce((s, sp) => s + sp.stats.total, 0);
  const passed = specs.reduce((s, sp) => s + sp.stats.passed, 0);
  const failed = specs.reduce((s, sp) => s + sp.stats.failed, 0);
  const skipped = specs.reduce((s, sp) => s + sp.stats.skipped, 0);
  const durationMs = raw.stats?.duration ?? specs.reduce((s, sp) => s + sp.stats.duration_ms, 0);

  const startedAt = meta.started_at || raw.stats?.startTime || new Date().toISOString();

  return {
    meta: {
      ...meta,
      started_at: startedAt,
      finished_at: meta.finished_at || new Date(new Date(startedAt).getTime() + durationMs).toISOString(),
      reporter: "playwright",
    },
    stats: {
      total,
      passed,
      failed,
      skipped,
      pending: 0,
      duration_ms: durationMs,
    },
    specs,
  };
}
