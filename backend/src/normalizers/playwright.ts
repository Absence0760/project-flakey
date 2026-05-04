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

interface PlaywrightMetadata {
  retries?: {
    attempt: number;
    status: string;
    duration: number;
    error?: { message: string; stack?: string };
  }[];
  annotations?: { type: string; description?: string }[];
  tags?: string[];
  location?: { file: string; line: number; column: number };
  stdout?: string[];
  stderr?: string[];
  error_snippet?: string;
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

// Coerce duration to a non-negative finite integer. Undefined / NaN /
// negative values from a partial or buggy report would otherwise poison
// every aggregate via reduce(+) and (worse) trip
// `new Date(start + NaN).toISOString()` → RangeError when computing the
// run's finished_at, which crashes the upload endpoint.
function safeDuration(d: unknown): number {
  const n = typeof d === "number" ? d : Number(d);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function collectFromSuite(
  suite: PlaywrightSuite,
  parentPath: string[],
): { specs: Map<string, NormalizedTest[]> } {
  const result: Map<string, NormalizedTest[]> = new Map();
  const titlePath = suite.title ? [...parentPath, suite.title] : parentPath;
  const filePath = suite.file ?? titlePath.join(" > ");

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      const lastResult = test.results[test.results.length - 1];
      if (!lastResult) continue;

      const specFile = spec.file ?? suite.file ?? filePath;
      const fullTitle = [...titlePath, spec.title].filter(Boolean).join(" > ");

      // Build metadata
      const metadata: PlaywrightMetadata = {};

      // Retry history (all attempts)
      if (test.results.length > 1) {
        metadata.retries = test.results.map((r, i) => ({
          attempt: i + 1,
          status: r.status,
          duration: r.duration,
          error: r.error ? { message: r.error.message ?? "Unknown error", stack: r.error.stack } : undefined,
        }));
      }

      // Annotations
      if (test.annotations?.length) {
        metadata.annotations = test.annotations;
      }

      // Tags (merge from spec and test, deduplicate)
      const allTags = [...(spec.tags ?? []), ...(test.tags ?? [])];
      if (allTags.length) {
        metadata.tags = [...new Set(allTags)];
      }

      // Source location
      if (test.location) {
        metadata.location = test.location;
      }

      // Console output (truncate to last 100 lines)
      if (lastResult.stdout?.length) {
        metadata.stdout = lastResult.stdout.slice(-100);
      }
      if (lastResult.stderr?.length) {
        metadata.stderr = lastResult.stderr.slice(-100);
      }

      // Error snippet
      const snippet = lastResult.error?.snippet ?? lastResult.errors?.[0]?.snippet;
      if (snippet) {
        metadata.error_snippet = snippet;
      }

      const normalized: NormalizedTest = {
        title: spec.title,
        full_title: fullTitle,
        status: mapStatus(lastResult),
        duration_ms: safeDuration(lastResult.duration),
        error: extractError(lastResult),
        screenshot_paths: extractScreenshots(lastResult),
        video_path: extractVideo(lastResult),
        ...(Object.keys(metadata).length > 0 ? { metadata: metadata as Record<string, unknown> } : {}),
      };

      const existing = result.get(specFile) ?? [];
      existing.push(normalized);
      result.set(specFile, existing);
    }
  }

  for (const child of suite.suites ?? []) {
    const childResult = collectFromSuite(child, titlePath);
    for (const [key, tests] of childResult.specs) {
      const existing = result.get(key) ?? [];
      existing.push(...tests);
      result.set(key, tests.length > 0 ? existing : []);
    }
  }

  return { specs: result };
}

export function parsePlaywright(
  raw: PlaywrightReport,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const allTests = new Map<string, NormalizedTest[]>();

  for (const suite of raw.suites ?? []) {
    const { specs } = collectFromSuite(suite, []);
    for (const [file, tests] of specs) {
      const existing = allTests.get(file) ?? [];
      existing.push(...tests);
      allTests.set(file, existing);
    }
  }

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
  const durationMs = safeDuration(raw.stats?.duration ?? specs.reduce((s, sp) => s + sp.stats.duration_ms, 0));

  // startedAt and finishedAt must be representable ISO strings, not
  // "Invalid Date". `new Date("garbage").toISOString()` throws RangeError,
  // which would 500 the entire upload endpoint.
  const startedRaw = meta.started_at || raw.stats?.startTime || new Date().toISOString();
  const startedDate = new Date(startedRaw);
  const startedAt = Number.isFinite(startedDate.getTime())
    ? startedDate.toISOString()
    : new Date().toISOString();

  const finishedAt = meta.finished_at
    || new Date(new Date(startedAt).getTime() + durationMs).toISOString();

  return {
    meta: {
      ...meta,
      started_at: startedAt,
      finished_at: finishedAt,
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
