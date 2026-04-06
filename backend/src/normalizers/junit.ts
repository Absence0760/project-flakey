import { XMLParser } from "fast-xml-parser";
import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

// JUnit XML can have either <testsuites><testsuite>... or a single <testsuite>
interface JUnitTestCase {
  "@_name"?: string;
  "@_classname"?: string;
  "@_time"?: string;
  failure?: { "#text"?: string; "@_message"?: string; "@_type"?: string } | string;
  error?: { "#text"?: string; "@_message"?: string; "@_type"?: string } | string;
  skipped?: unknown;
  "system-out"?: string;
  "system-err"?: string;
}

interface JUnitTestSuite {
  "@_name"?: string;
  "@_tests"?: string;
  "@_failures"?: string;
  "@_errors"?: string;
  "@_skipped"?: string;
  "@_time"?: string;
  "@_timestamp"?: string;
  "@_file"?: string;
  testcase?: JUnitTestCase | JUnitTestCase[];
}

interface JUnitReport {
  testsuites?: {
    "@_name"?: string;
    "@_tests"?: string;
    "@_failures"?: string;
    "@_errors"?: string;
    "@_time"?: string;
    testsuite?: JUnitTestSuite | JUnitTestSuite[];
  };
  testsuite?: JUnitTestSuite | JUnitTestSuite[];
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function parseSeconds(time?: string): number {
  if (!time) return 0;
  const n = parseFloat(time);
  return isNaN(n) ? 0 : Math.round(n * 1000);
}

function getFailureMessage(node: JUnitTestCase["failure"]): { message: string; stack?: string } | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return { message: node };
  const message = node["@_message"] || node["#text"] || "Unknown failure";
  const stack = node["#text"] || undefined;
  return { message, stack: stack !== message ? stack : undefined };
}

function parseTestCase(tc: JUnitTestCase, suiteName: string): NormalizedTest {
  const title = tc["@_name"] ?? "Unknown test";
  const classname = tc["@_classname"] ?? suiteName;
  const durationMs = parseSeconds(tc["@_time"]);

  let status: NormalizedTest["status"] = "passed";
  let error: NormalizedTest["error"] | undefined;

  if (tc.skipped !== undefined && tc.skipped !== null) {
    status = "skipped";
  } else if (tc.failure !== undefined && tc.failure !== null) {
    status = "failed";
    error = getFailureMessage(tc.failure);
  } else if (tc.error !== undefined && tc.error !== null) {
    status = "failed";
    error = getFailureMessage(tc.error);
  }

  return {
    title,
    full_title: `${classname} > ${title}`,
    status,
    duration_ms: durationMs,
    error,
    screenshot_paths: [],
  };
}

function parseSuite(suite: JUnitTestSuite): NormalizedSpec {
  const testCases = toArray(suite.testcase);
  const suiteName = suite["@_name"] ?? "Unknown suite";
  const filePath = suite["@_file"] ?? suiteName;

  const tests = testCases.map((tc) => parseTestCase(tc, suiteName));

  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending").length;

  return {
    file_path: filePath,
    title: suiteName,
    stats: {
      total: tests.length,
      passed,
      failed,
      skipped,
      duration_ms: tests.reduce((sum, t) => sum + t.duration_ms, 0),
    },
    tests,
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  trimValues: true,
});

export function parseJUnit(
  raw: string | JUnitReport,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  // raw can be an XML string or already-parsed object
  const parsed: JUnitReport = typeof raw === "string" ? xmlParser.parse(raw) : raw;

  // Gather all test suites from either <testsuites><testsuite>... or top-level <testsuite>
  let suites: JUnitTestSuite[] = [];
  if (parsed.testsuites) {
    suites = toArray(parsed.testsuites.testsuite);
  } else if (parsed.testsuite) {
    suites = toArray(parsed.testsuite);
  }

  const specs = suites.map(parseSuite);

  const total = specs.reduce((s, sp) => s + sp.stats.total, 0);
  const passed = specs.reduce((s, sp) => s + sp.stats.passed, 0);
  const failed = specs.reduce((s, sp) => s + sp.stats.failed, 0);
  const skipped = specs.reduce((s, sp) => s + sp.stats.skipped, 0);
  const durationMs = specs.reduce((s, sp) => s + sp.stats.duration_ms, 0);

  // Try to extract timestamps from suites or top-level attributes
  const timestamps = suites
    .map((s) => s["@_timestamp"])
    .filter(Boolean)
    .sort();
  const startedAt = meta.started_at || timestamps[0] || new Date().toISOString();
  const totalSeconds = parsed.testsuites?.["@_time"]
    ? parseFloat(parsed.testsuites["@_time"]) * 1000
    : durationMs;

  return {
    meta: {
      ...meta,
      started_at: startedAt,
      finished_at: meta.finished_at || new Date(new Date(startedAt).getTime() + totalSeconds).toISOString(),
      reporter: "junit",
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
