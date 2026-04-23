#!/usr/bin/env node

/**
 * Parses the Newman JUnit XML emitted by test:smoke and generates two files:
 *
 *   coverage/api-coverage-summary.json  — human-readable API endpoint coverage
 *   coverage/coverage-summary.json      — Istanbul-shaped wrapper consumed by
 *                                         `flakey-upload coverage --file ...`
 *
 * Mapping to Istanbul fields (all endpoint-based — no line/branch data exists
 * for API suites, so we re-use the Istanbul schema as a numeric carrier):
 *   statements / lines  → endpoint assertion coverage  (passed / total)
 *   functions / branches → always mirror statements (no per-function data)
 *
 * Usage: node scripts/generate-coverage.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const REPORT_PATH = "reports/results.xml";

if (!existsSync(REPORT_PATH)) {
  console.error(`[coverage] No report found at ${REPORT_PATH} — run test:smoke first`);
  process.exit(1);
}

const xml = readFileSync(REPORT_PATH, "utf-8");

// Count total test cases and failures from JUnit XML attributes.
// Newman emits <testsuite tests="N" failures="F" ...> at the top level
// and individual <testcase> elements, some with <failure> children.

let endpointsTotal = 0;
let endpointsFailed = 0;

// Parse testsuite totals (fast path — avoids a full XML parser dependency)
const suiteMatches = [...xml.matchAll(/<testsuite[^>]+tests="(\d+)"[^>]*failures="(\d+)"/g)];
if (suiteMatches.length > 0) {
  for (const m of suiteMatches) {
    endpointsTotal += Number(m[1]);
    endpointsFailed += Number(m[2]);
  }
} else {
  // Fallback: count <testcase> elements and <failure> children
  endpointsTotal = (xml.match(/<testcase[\s>]/g) ?? []).length;
  endpointsFailed = (xml.match(/<failure[\s>]/g) ?? []).length;
}

const endpointsCovered = endpointsTotal - endpointsFailed;
const pct = endpointsTotal > 0
  ? Math.round((endpointsCovered / endpointsTotal) * 10000) / 100
  : 0;

// Extract endpoint names from classname / name attributes for the summary
const endpointNames = [];
for (const m of xml.matchAll(/<testcase[^>]+name="([^"]+)"/g)) {
  endpointNames.push(m[1]);
}

// Human-readable summary
const apiSummary = {
  endpointsCovered,
  endpointsTotal,
  endpointsFailed,
  coveragePct: pct,
  endpoints: endpointNames,
  generatedAt: new Date().toISOString(),
};

// Istanbul-shaped wrapper (the CLI normalizeIstanbulSummary reads report.total)
const istanbulSummary = {
  total: {
    lines:      { total: endpointsTotal, covered: endpointsCovered, skipped: 0, pct },
    statements: { total: endpointsTotal, covered: endpointsCovered, skipped: 0, pct },
    functions:  { total: endpointsTotal, covered: endpointsCovered, skipped: 0, pct },
    branches:   { total: endpointsTotal, covered: endpointsCovered, skipped: 0, pct },
  },
};

mkdirSync("coverage", { recursive: true });
writeFileSync("coverage/api-coverage-summary.json", JSON.stringify(apiSummary, null, 2));
writeFileSync("coverage/coverage-summary.json", JSON.stringify(istanbulSummary, null, 2));

console.log(
  `[coverage] ${endpointsCovered}/${endpointsTotal} endpoints covered (${pct}%)` +
  ` — wrote coverage/api-coverage-summary.json + coverage/coverage-summary.json`
);
