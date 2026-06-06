/**
 * Reporter payload replay CLI (Phase 13) — unit tests.
 *
 * Drive the same code path the CLI uses (parseArgs + replayPayload) against
 * the committed fixtures, with no DB and no process spawn. Covers arg parsing,
 * reporter auto-detection, the JUnit-as-string vs JSON branch, and error cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { replayPayload, detectReporter, parseArgs } from "../scripts/replay-payload.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("auto-detects reporter from filename", () => {
  assert.equal(detectReporter("mochawesome.cypress-realistic.json"), "mochawesome");
  assert.equal(detectReporter("playwright.realistic.json"), "playwright");
  assert.equal(detectReporter("junit.realistic.xml"), "junit");
  assert.equal(detectReporter("jest.realistic.json"), "jest");
  assert.equal(detectReporter("report.wdio.json"), "webdriverio");
  assert.equal(detectReporter("mystery.json"), null);
});

test("replays a mochawesome (Cypress) fixture into a NormalizedRun", () => {
  const run = replayPayload(join(FIXTURES, "mochawesome.cypress-realistic.json"));
  assert.equal(run.meta.reporter, "mochawesome");
  assert.ok(run.specs.length > 0, "should produce at least one spec");
  // stats are internally consistent
  assert.equal(
    run.stats.total,
    run.stats.passed + run.stats.failed + run.stats.skipped + run.stats.pending,
    "total must equal the sum of the per-status counts",
  );
});

test("replays a JUnit XML fixture (raw string path, not JSON.parse)", () => {
  const run = replayPayload(join(FIXTURES, "junit.realistic.xml"));
  assert.equal(run.meta.reporter, "junit");
  assert.ok(run.stats.total > 0, "JUnit fixture should yield tests");
});

test("explicit --reporter override beats filename detection", () => {
  // The fixture IS mochawesome; forcing the correct reporter must still work
  // and produce the same shape as auto-detect.
  const auto = replayPayload(join(FIXTURES, "mochawesome.cypress-realistic.json"));
  const forced = replayPayload(join(FIXTURES, "mochawesome.cypress-realistic.json"), "mochawesome");
  assert.deepEqual(forced.stats, auto.stats);
});

test("throws a helpful error when the reporter can't be inferred", () => {
  assert.throws(
    () => replayPayload("/tmp/unknownshape.dat"),
    /Could not infer the reporter/,
  );
});

test("throws on an unsupported explicit reporter", () => {
  assert.throws(
    () => replayPayload(join(FIXTURES, "mochawesome.cypress-realistic.json"), "cypress"),
    /Unsupported reporter/,
  );
});

test("throws a readable error on malformed JSON", () => {
  // The XML fixture is valid XML but not JSON — forcing a JSON reporter on it
  // exercises the parse-error branch.
  assert.throws(
    () => replayPayload(join(FIXTURES, "junit.realistic.xml"), "mochawesome"),
    /Failed to parse .* as JSON/,
  );
});

test("parseArgs: positional path + flags in any order", () => {
  assert.deepEqual(parseArgs(["report.json"]), { filePath: "report.json", pretty: false });
  assert.deepEqual(parseArgs(["--pretty", "report.json"]), { filePath: "report.json", pretty: true });
  assert.deepEqual(parseArgs(["report.json", "--reporter", "junit"]), {
    filePath: "report.json", reporter: "junit", pretty: false,
  });
  assert.deepEqual(parseArgs(["report.json", "--reporter=playwright", "--pretty"]), {
    filePath: "report.json", reporter: "playwright", pretty: true,
  });
});
