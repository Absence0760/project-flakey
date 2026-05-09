import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";

import { parseTrace, parseAndSaveTrace } from "../index.ts";

/**
 * Unit tests for the Playwright trace parser.
 *
 * Tests build a synthetic trace.zip in-memory using AdmZip. The shape
 * mirrors what `playwright test --trace=on` actually writes:
 *   - 0-trace.trace — newline-delimited JSON with context-options,
 *     screencast frames, and before/after action pairs.
 *   - resources/<sha1>.jpeg — the screencast frames referenced by the
 *     `sha1` field of the screencast entries.
 *
 * The package has zero coverage today and is on the upload hot path
 * for every Playwright run — a regression in trace parsing silently
 * drops command logs and DOM snapshots from every consumer's
 * dashboard.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "flakey-snapshots-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Build an in-memory Playwright-style trace zip. Returns the path to a
 * `.zip` file inside tmpRoot containing:
 *   - 0-trace.trace with the supplied JSON-newline lines
 *   - resources/<filename> for each entry in `resources`
 */
function buildTraceZip(lines: any[], resources: Record<string, Buffer>): string {
  const zip = new AdmZip();
  const traceText = lines.map((l) => JSON.stringify(l)).join("\n");
  zip.addFile("0-trace.trace", Buffer.from(traceText, "utf8"));
  for (const [name, buf] of Object.entries(resources)) {
    zip.addFile(`resources/${name}`, buf);
  }
  const path = join(tmpRoot, "trace.zip");
  zip.writeZip(path);
  return path;
}

const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]); // tiny "valid-enough" JPEG bytes

test("parseTrace returns empty result when the trace path doesn't exist (no throw)", () => {
  const r = parseTrace(join(tmpRoot, "no-such-file.zip"), "any test", "any.spec.ts");
  assert.deepEqual(r, { commandLog: [], snapshotBundle: null });
});

test("parseTrace returns empty result when the zip has no 0-trace.trace entry", () => {
  // A zip with only a network trace and no library trace.
  const zip = new AdmZip();
  zip.addFile("0-network.trace", Buffer.from('{"type":"context-options"}', "utf8"));
  const path = join(tmpRoot, "trace.zip");
  zip.writeZip(path);

  const r = parseTrace(path, "x", "y.spec.ts");
  assert.deepEqual(r, { commandLog: [], snapshotBundle: null });
});

test("commandLog is built from before/after action pairs whose class is in ACTION_CLASSES", () => {
  const path = buildTraceZip(
    [
      { type: "context-options", options: { viewport: { width: 1024, height: 768 } } },
      // action 1 — Page.goto, succeeds
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "http://app.test" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
      // action 2 — Locator.click, FAILS. The trailing `s` is the
      // selector-engine suffix Playwright appends after the closing
      // bracket (e.g. `[data-testid="login"]s`).
      { type: "before", callId: "c2", class: "Locator", method: "click", params: { selector: "internal:testid=[data-testid=\"login\"]s" }, startTime: 300 },
      { type: "after", callId: "c2", endTime: 350, error: { name: "TimeoutError", message: "click timed out" } },
      // a 'before' for an internal class that should be IGNORED
      { type: "before", callId: "c3", class: "InternalThingy", method: "private", params: {}, startTime: 400 },
      { type: "after", callId: "c3", endTime: 410 },
    ],
    {},
  );

  const { commandLog, snapshotBundle } = parseTrace(path, "checkout flow", "checkout.spec.ts");

  // Two entries (goto + click); the InternalThingy was filtered out by ACTION_CLASSES.
  assert.equal(commandLog.length, 2);
  assert.equal(commandLog[0].name, "goto");
  assert.equal(commandLog[0].message, "http://app.test");
  assert.equal(commandLog[0].state, "passed");

  assert.equal(commandLog[1].name, "click");
  assert.equal(
    commandLog[1].message,
    "[data-testid=\"login\"]",
    "internal:testid=[data-testid=\"login\"s] should clean to bracket form",
  );
  assert.equal(commandLog[1].state, "failed",
    "after.error → command state must be 'failed'");

  // No screencast frames + no resources → no snapshot bundle.
  assert.equal(snapshotBundle, null);
});

test("snapshotBundle is built when screencast frames + resources line up by sha1", () => {
  const path = buildTraceZip(
    [
      { type: "context-options", options: { viewport: { width: 1280, height: 720 } } },
      { type: "screencastFrame", sha1: "frame_abc", timestamp: 150, width: 1280, height: 720 },
      { type: "screencastFrame", sha1: "frame_def", timestamp: 320, width: 1280, height: 720 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 160 },
      { type: "before", callId: "c2", class: "Locator", method: "click", params: { selector: "button#go" }, startTime: 300 },
      { type: "after", callId: "c2", endTime: 330 },
    ],
    {
      "frame_abc.jpeg": fakeJpeg,
      "frame_def.jpeg": fakeJpeg,
    },
  );

  const { commandLog, snapshotBundle } = parseTrace(path, "checkout", "x.spec.ts");
  assert.equal(commandLog.length, 2);
  assert.ok(snapshotBundle, "expected a snapshotBundle");
  assert.equal(snapshotBundle.testTitle, "checkout");
  assert.equal(snapshotBundle.specFile, "x.spec.ts");
  assert.equal(snapshotBundle.viewportWidth, 1280);
  assert.equal(snapshotBundle.viewportHeight, 720);
  assert.equal(snapshotBundle.steps.length, 2,
    "one snapshot step per action, each matched to its closest screencast frame");

  const step0 = snapshotBundle.steps[0];
  assert.equal(step0.commandName, "goto");
  assert.ok(step0.html.includes("data:image/jpeg;base64,"),
    "step HTML should embed the matched frame as a base64 data URL");
  assert.equal(step0.timestamp, (160 - 100) * 1000,
    "timestamp is (action time - run start) in microseconds; matches Cypress convention");
});

test("frame matching prefers the temporally-closest screencast frame", () => {
  const path = buildTraceZip(
    [
      { type: "screencastFrame", sha1: "early", timestamp: 100, width: 100, height: 100 },
      { type: "screencastFrame", sha1: "perfect", timestamp: 500, width: 100, height: 100 },
      { type: "screencastFrame", sha1: "late", timestamp: 900, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "click", params: { selector: "btn" }, startTime: 480 },
      { type: "after", callId: "c1", endTime: 510 },
    ],
    {
      "early.jpeg": Buffer.from("EARLY"),
      "perfect.jpeg": Buffer.from("PERFECT"),
      "late.jpeg": Buffer.from("LATE"),
    },
  );

  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle);
  const step = snapshotBundle.steps[0];
  // The base64 of "PERFECT" is "UEVSRkVDVA=="
  assert.ok(step.html.includes("UEVSRkVDVA=="),
    "the action at endTime 510 should match the frame at 500, not 100 or 900");
  assert.equal(step.html.includes("RUFSTFk="), false, "must NOT match 'EARLY'");
  assert.equal(step.html.includes("TEFURQ=="), false, "must NOT match 'LATE'");
});

test("frames whose sha1 has no matching resource entry are skipped (don't produce a step)", () => {
  const path = buildTraceZip(
    [
      // Frame references a resource we don't include in the zip.
      { type: "screencastFrame", sha1: "missing-frame", timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "click", params: { selector: "x" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ],
    {
      // No "missing-frame.jpeg" — resource is genuinely missing.
    },
  );

  const { commandLog, snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  // The action still appears in the command log...
  assert.equal(commandLog.length, 1);
  // ...but the snapshot bundle is null because no step could be built.
  assert.equal(snapshotBundle, null,
    "with zero usable steps, snapshotBundle should be null (not an empty steps array)");
});

test("PNG resources are accepted alongside JPEG", () => {
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const path = buildTraceZip(
    [
      { type: "screencastFrame", sha1: "png_frame", timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ],
    {
      "png_frame.png": fakePng,
    },
  );

  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle);
  assert.ok(snapshotBundle.steps[0].html.includes("data:image/png;base64,"),
    "PNG resources should produce a data:image/png URL, not jpeg");
});

test("malformed trace lines (invalid JSON, missing fields) are skipped silently", () => {
  // Mix of valid lines, invalid JSON, and oddly-shaped objects. Parser
  // must not throw.
  const path = buildTraceZip(
    [
      // raw push of garbage: AdmZip won't help with non-JSON lines so
      // we'll write the trace text manually below instead of using the
      // helper. Use the helper here for the well-formed parts only.
      { type: "context-options", options: { viewport: { width: 800, height: 600 } } },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 1 },
      { type: "after", callId: "c1", endTime: 2 },
    ],
    {},
  );
  // Now overwrite the 0-trace.trace inside the zip with mixed garbage.
  const zip = new AdmZip(path);
  const goodText = zip.getEntry("0-trace.trace")!.getData().toString("utf8");
  const messy = [
    goodText,
    "this is not json",
    "{not valid",
    `{"type":"unknown-future-event","fields":["that","we","ignore"]}`,
    "",
    `{"type":"before","callId":"c2","class":"Page","method":"reload","params":{},"startTime":3}`,
    `{"type":"after","callId":"c2","endTime":4}`,
  ].join("\n");
  zip.deleteFile("0-trace.trace");
  zip.addFile("0-trace.trace", Buffer.from(messy, "utf8"));
  zip.writeZip(path);

  const { commandLog } = parseTrace(path, "x", "x.spec.ts");
  // Both well-formed action pairs (goto, reload) survive. Garbage is
  // silently dropped.
  assert.equal(commandLog.length, 2);
  assert.equal(commandLog[0].name, "goto");
  assert.equal(commandLog[1].name, "reload");
});

test("default viewport (1280x720) is used when context-options is absent", () => {
  const path = buildTraceZip(
    [
      // No context-options entry.
      { type: "screencastFrame", sha1: "f", timestamp: 1, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 0 },
      { type: "after", callId: "c1", endTime: 2 },
    ],
    { "f.jpeg": fakeJpeg },
  );
  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle);
  assert.equal(snapshotBundle.viewportWidth, 1280);
  assert.equal(snapshotBundle.viewportHeight, 720);
});

test("alternative event-type spelling 'screencast-frame' is also accepted (Playwright trace-format compatibility)", () => {
  const path = buildTraceZip(
    [
      // Hyphenated form (some Playwright versions emit this)
      { type: "screencast-frame", sha1: "h", timestamp: 1, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 0 },
      { type: "after", callId: "c1", endTime: 2 },
    ],
    { "h.jpeg": fakeJpeg },
  );
  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle, "the parser must accept both 'screencastFrame' and 'screencast-frame'");
  assert.equal(snapshotBundle.steps.length, 1);
});

test("formatAction renders fill / press / click / expect with their argument shapes", () => {
  const path = buildTraceZip(
    [
      // fill: selector → value
      { type: "before", callId: "c1", class: "Locator", method: "fill", params: { selector: "#email", value: "a@b.com" }, startTime: 1 },
      { type: "after", callId: "c1", endTime: 2 },
      // press: selector → key
      { type: "before", callId: "c2", class: "Locator", method: "press", params: { selector: "#email", key: "Enter" }, startTime: 3 },
      { type: "after", callId: "c2", endTime: 4 },
      // click: selector
      { type: "before", callId: "c3", class: "Locator", method: "click", params: { selector: "#submit" }, startTime: 5 },
      { type: "after", callId: "c3", endTime: 6 },
      // expect: selector + expression + expectedText
      { type: "before", callId: "c4", class: "Locator", method: "expect", params: { selector: "#welcome", expression: "to.contain.text", expectedText: [{ string: "Hi a@b.com" }] }, startTime: 7 },
      { type: "after", callId: "c4", endTime: 8 },
    ],
    {},
  );
  const { commandLog } = parseTrace(path, "x", "x.spec.ts");

  assert.equal(commandLog[0].message, '#email → "a@b.com"',
    "fill should render as 'selector → \"value\"'");
  assert.equal(commandLog[1].message, "#email → Enter",
    "press should render as 'selector → key' (no quotes around key)");
  assert.equal(commandLog[2].message, "#submit",
    "click should render the selector alone");
  assert.equal(commandLog[3].message, '#welcome to.contain.text "Hi a@b.com"',
    "expect should render selector + expression + expected");
});

test("parseAndSaveTrace gzip-writes the snapshot bundle and returns the file path", () => {
  const path = buildTraceZip(
    [
      { type: "screencastFrame", sha1: "f", timestamp: 1, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 0 },
      { type: "after", callId: "c1", endTime: 2 },
    ],
    { "f.jpeg": fakeJpeg },
  );

  const outputDir = join(tmpRoot, "snapshots-out");
  const { commandLog, snapshotPath } = parseAndSaveTrace(
    path,
    "Auth flow > should sign in",
    "tests/auth/login.spec.ts",
    outputDir,
  );

  assert.equal(commandLog.length, 1);
  assert.ok(snapshotPath, "expected a non-null snapshotPath");
  assert.ok(existsSync(snapshotPath), "the snapshot file should exist on disk");

  // Filename: <safe-spec>--<safe-title>.json.gz
  //   spec  "tests/auth/login.spec.ts"        → "tests__auth__login.spec.ts"
  //   title "Auth flow > should sign in"      → "Auth-flow-should-sign-in"
  //         (the `>` is non-alphanum, gets stripped; surrounding spaces
  //          collapse with the rest into single dashes via \s+ → '-')
  assert.match(snapshotPath, /tests__auth__login\.spec\.ts--Auth-flow-should-sign-in\.json\.gz$/);

  // The file is gzipped JSON of a SnapshotBundle.
  const parsed = JSON.parse(gunzipSync(readFileSync(snapshotPath)).toString("utf8"));
  assert.equal(parsed.testTitle, "Auth flow > should sign in");
  assert.equal(parsed.specFile, "tests/auth/login.spec.ts");
  assert.equal(parsed.steps.length, 1);
});

test("parseAndSaveTrace returns snapshotPath: null and writes nothing when there are no usable steps", () => {
  const path = buildTraceZip(
    [
      // before/after pair but NO screencast frames → no steps → no bundle.
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 0 },
      { type: "after", callId: "c1", endTime: 2 },
    ],
    {},
  );

  const outputDir = join(tmpRoot, "no-snapshots");
  const { commandLog, snapshotPath } = parseAndSaveTrace(path, "x", "y.spec.ts", outputDir);
  assert.equal(commandLog.length, 1, "commandLog still surfaces the action");
  assert.equal(snapshotPath, null,
    "no usable snapshot data → null path (and no file written)");
  assert.equal(existsSync(outputDir), false,
    "the output dir is only created when there's something to write");
});
