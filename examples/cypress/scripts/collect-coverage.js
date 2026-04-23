#!/usr/bin/env node
/**
 * collect-coverage.js
 *
 * The example todo app (examples/shared/app/index.html) is a plain HTML file
 * with inline JavaScript — it is not instrumented by Istanbul/nyc, so there is
 * no real coverage data to collect.
 *
 * This script emits a static coverage/coverage-summary.json that matches the
 * Istanbul coverage-summary format.  The numbers are representative of a
 * modestly-covered project and are clearly labelled as example data so users
 * understand the tradeoff before wiring this into their own CI pipeline.
 *
 * To use real coverage in your project:
 *   1. Instrument your app with Istanbul (via babel-plugin-istanbul or nyc).
 *   2. Use @cypress/code-coverage to merge per-test coverage at the end of
 *      each spec and write coverage/coverage-final.json.
 *   3. Run `nyc report --reporter=json-summary` to produce coverage-summary.json.
 *   4. Then run `pnpm coverage:upload` (set FLAKEY_RUN_ID to the run you want
 *      to attach coverage to) to ship it to Better Testing.
 */

"use strict";

const { writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");

const outDir = join(__dirname, "..", "coverage");
const outFile = join(outDir, "coverage-summary.json");

// Static example coverage summary in Istanbul coverage-summary.json format.
// Adjust these numbers to match your application's actual coverage target.
const summary = {
  total: {
    lines:      { total: 320, covered: 238, skipped: 0, pct: 74.38 },
    statements: { total: 345, covered: 257, skipped: 0, pct: 74.49 },
    functions:  { total:  42, covered:  31, skipped: 0, pct: 73.81 },
    branches:   { total:  88, covered:  59, skipped: 0, pct: 67.05 },
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log("[collect-coverage] wrote " + outFile);
console.log("[collect-coverage] NOTE: this is static example data — see script comments for real coverage setup.");
