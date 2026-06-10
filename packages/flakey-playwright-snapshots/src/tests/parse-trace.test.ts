import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";

import { parseTrace, parseAndSaveTrace, cleanSelector } from "../index.ts";

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
function buildTraceZip(
  lines: any[],
  resources: Record<string, Buffer>,
  networkLines?: any[],
): string {
  const zip = new AdmZip();
  const traceText = lines.map((l) => JSON.stringify(l)).join("\n");
  zip.addFile("0-trace.trace", Buffer.from(traceText, "utf8"));
  // Network events live in a separate "*.network" file (named "trace.network"
  // inside the zip in Playwright 1.59) — mirror that here.
  if (networkLines && networkLines.length > 0) {
    const netText = networkLines.map((l) => JSON.stringify(l)).join("\n");
    zip.addFile("trace.network", Buffer.from(netText, "utf8"));
  }
  for (const [name, buf] of Object.entries(resources)) {
    zip.addFile(`resources/${name}`, buf);
  }
  const path = join(tmpRoot, "trace.zip");
  zip.writeZip(path);
  return path;
}

// A "resource-snapshot" network entry as Playwright writes it to the .network
// file: a HAR entry under `snapshot`, with the monotonic start time inline.
function netEntry(method: string, url: string, status: number, monotonicTime: number) {
  return {
    type: "resource-snapshot",
    snapshot: {
      _monotonicTime: monotonicTime,
      request: { method, url },
      response: { status },
    },
  };
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
  assert.equal(step0.timestamp, 160 - 100,
    "timestamp is (action end - run start) in MILLISECONDS — same unit as the Cypress producer, so the viewer can derive per-step durations");
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

  // Filename: <safe-spec>--<safe-title>-<sha8>.json.gz
  //   spec  "tests/auth/login.spec.ts"        → "tests__auth__login.spec.ts"
  //   title "Auth flow > should sign in"      → "Auth-flow-should-sign-in"
  //         (the `>` is non-alphanum, gets stripped; surrounding spaces
  //          collapse with the rest into single dashes via \s+ → '-')
  //   plus an 8-hex-char hash of the raw spec::title identity to disambiguate
  //   distinct tests that sanitize to the same name.
  assert.match(snapshotPath, /tests__auth__login\.spec\.ts--Auth-flow-should-sign-in-[0-9a-f]{8}\.json\.gz$/);

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

/**
 * Helper for the trace-file-selection cases below: real Playwright trace
 * zips ship several `.trace` files (the library trace `0-trace.trace`, the
 * `0-network.trace`, a `*-stacks.trace`, etc.). The parser must select the
 * library trace and ignore the others. `buildTraceZip` only ever writes
 * `0-trace.trace`, so these cases assemble the zip directly.
 */
function buildMultiTraceZip(
  traceFiles: Record<string, any[]>,
  resources: Record<string, Buffer> = {},
): string {
  const zip = new AdmZip();
  for (const [fileName, lines] of Object.entries(traceFiles)) {
    const text = lines.map((l) => JSON.stringify(l)).join("\n");
    zip.addFile(fileName, Buffer.from(text, "utf8"));
  }
  for (const [name, buf] of Object.entries(resources)) {
    zip.addFile(`resources/${name}`, buf);
  }
  const path = join(tmpRoot, "trace.zip");
  zip.writeZip(path);
  return path;
}

test("with both 0-trace.trace and 0-network.trace present, the library trace is used and network is ignored", () => {
  const path = buildMultiTraceZip({
    // The real page actions live here.
    "0-trace.trace": [
      { type: "context-options", options: { viewport: { width: 1280, height: 720 } } },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "http://app.test" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ],
    // The network trace carries request/response events that look like
    // actions but use a different class — if the parser read this file it
    // would either pick up the wrong "action" or (more likely) parse a
    // before/after pair that should never reach the command log.
    "0-network.trace": [
      { type: "before", callId: "n1", class: "Page", method: "fetch", params: { url: "http://api.test/secret" }, startTime: 150 },
      { type: "after", callId: "n1", endTime: 175 },
    ],
  });

  const { commandLog } = parseTrace(path, "x", "x.spec.ts");

  // Exactly the one action from 0-trace.trace; nothing from the network trace.
  assert.equal(commandLog.length, 1,
    "only the library trace's actions should be parsed; the network trace is ignored");
  assert.equal(commandLog[0].name, "goto");
  assert.equal(commandLog[0].message, "http://app.test");
  assert.equal(
    commandLog.some((c) => c.name === "fetch"),
    false,
    "the network trace's 'fetch' action must not leak into the command log",
  );
});

test("falls back to a non-network .trace when 0-trace.trace is absent", () => {
  // No "0-trace.trace". The library actions are in "1-trace.trace"; a
  // network trace and a stacks trace are present and must both be ignored.
  const path = buildMultiTraceZip({
    "1-trace.trace": [
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "http://fallback.test" }, startTime: 10 },
      { type: "after", callId: "c1", endTime: 20 },
    ],
    "0-network.trace": [
      { type: "before", callId: "n1", class: "Page", method: "fetch", params: { url: "http://api.test" }, startTime: 12 },
      { type: "after", callId: "n1", endTime: 18 },
    ],
    "0-stacks.trace": [
      { type: "before", callId: "s1", class: "Page", method: "evaluate", params: {}, startTime: 11 },
      { type: "after", callId: "s1", endTime: 19 },
    ],
  });

  const { commandLog } = parseTrace(path, "x", "x.spec.ts");

  assert.equal(commandLog.length, 1,
    "the non-network/non-stacks .trace must be used as a fallback for 0-trace.trace");
  assert.equal(commandLog[0].name, "goto");
  assert.equal(commandLog[0].message, "http://fallback.test");
});

test("0-trace.trace always wins over another library trace, regardless of zip order", () => {
  // Insert a decoy 1-trace.trace BEFORE 0-trace.trace. Selection by zip
  // iteration order (the old last-write-wins behaviour) would pick the decoy;
  // the parser must canonicalise on 0-trace.trace.
  const path = buildMultiTraceZip({
    "1-trace.trace": [
      { type: "before", callId: "d1", class: "Page", method: "goto", params: { url: "http://decoy.test" }, startTime: 10 },
      { type: "after", callId: "d1", endTime: 20 },
    ],
    "0-trace.trace": [
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "http://canonical.test" }, startTime: 30 },
      { type: "after", callId: "c1", endTime: 40 },
    ],
  });

  const { commandLog } = parseTrace(path, "x", "x.spec.ts");
  assert.equal(commandLog.length, 1);
  assert.equal(commandLog[0].message, "http://canonical.test",
    "0-trace.trace must be selected even when a later library trace exists");
});

test("with multiple non-canonical library traces, selection is deterministic (lowest-sorted name)", () => {
  // No 0-trace.trace; two library traces. Order them so zip iteration would
  // surface 2-trace.trace last — the parser must still pick 1-trace.trace.
  const path = buildMultiTraceZip({
    "2-trace.trace": [
      { type: "before", callId: "b1", class: "Page", method: "goto", params: { url: "http://two.test" }, startTime: 10 },
      { type: "after", callId: "b1", endTime: 20 },
    ],
    "1-trace.trace": [
      { type: "before", callId: "a1", class: "Page", method: "goto", params: { url: "http://one.test" }, startTime: 30 },
      { type: "after", callId: "a1", endTime: 40 },
    ],
  });

  const { commandLog } = parseTrace(path, "x", "x.spec.ts");
  assert.equal(commandLog.length, 1);
  assert.equal(commandLog[0].message, "http://one.test",
    "the lowest-sorted library trace is chosen deterministically, not by zip order");
});

test("an empty (truncated) image resource is base64'd as-is and still produces a step — no throw", () => {
  // A real trace can reference a frame whose resource file was written
  // empty (run killed mid-flush). adm-zip returns a zero-length Buffer;
  // base64 of "" is "" and the step is still emitted rather than crashing.
  const path = buildTraceZip(
    [
      { type: "screencastFrame", sha1: "empty_frame", timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ],
    {
      "empty_frame.jpeg": Buffer.alloc(0), // truncated/empty resource
    },
  );

  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle, "an empty resource must not abort bundle creation");
  assert.equal(snapshotBundle.steps.length, 1,
    "the step is still produced from a present-but-empty resource");
  // The empty buffer yields an empty base64 payload — the data URL prefix
  // is still there, the payload is just blank.
  assert.ok(
    snapshotBundle.steps[0].html.includes("data:image/jpeg;base64,\""),
    "empty resource base64s to an empty payload, leaving a bare data: URL",
  );
});

test("a corrupt/garbage image resource is base64'd verbatim (parser does not validate image bytes)", () => {
  // Non-image bytes under a .jpeg key. The parser is a passthrough — it
  // base64s whatever is there; downstream display is the viewer's problem,
  // not the parser's. The contract here is: don't crash, don't drop the step.
  const garbage = Buffer.from("not an image at all \x00\x01\x02", "binary");
  const path = buildTraceZip(
    [
      { type: "screencastFrame", sha1: "corrupt", timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ],
    {
      "corrupt.jpeg": garbage,
    },
  );

  const { snapshotBundle } = parseTrace(path, "x", "x.spec.ts");
  assert.ok(snapshotBundle);
  assert.equal(snapshotBundle.steps.length, 1);
  assert.ok(
    snapshotBundle.steps[0].html.includes(`data:image/jpeg;base64,${garbage.toString("base64")}`),
    "corrupt bytes are embedded verbatim as base64; the parser does not validate or reject them",
  );
});

test("two DISTINCT tests that sanitize to the same name get distinct files (hash suffix prevents clobber)", () => {
  // Both titles sanitize identically: "Login: works!" and "Login  works"
  //   strip non-alphanum (drops ':' and '!') then collapse \s+ → '-'
  //   → both become "Login-works". Before the hash suffix, the second silently
  //   overwrote the first — a whole test's snapshots lost. Now the raw-title
  //   hash disambiguates them.
  const buildOneStepTrace = (sha1: string, body: Buffer): string => {
    const zip = new AdmZip();
    const lines = [
      { type: "screencastFrame", sha1, timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ];
    zip.addFile("0-trace.trace", Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n"), "utf8"));
    zip.addFile(`resources/${sha1}.jpeg`, body);
    const p = join(tmpRoot, `trace-${sha1}.zip`);
    zip.writeZip(p);
    return p;
  };

  const outputDir = join(tmpRoot, "collide");
  const firstBody = Buffer.from("FIRST");
  const secondBody = Buffer.from("SECOND");

  const first = parseAndSaveTrace(buildOneStepTrace("aaa", firstBody), "Login: works!", "spec.ts", outputDir);
  const second = parseAndSaveTrace(buildOneStepTrace("bbb", secondBody), "Login  works", "spec.ts", outputDir);

  assert.ok(first.snapshotPath && second.snapshotPath);
  assert.notEqual(second.snapshotPath, first.snapshotPath,
    "distinct tests must resolve to DISTINCT files even when their names sanitize identically");
  // Both share the sanitized stem but differ in the trailing hash.
  assert.match(first.snapshotPath, /spec\.ts--Login-works-[0-9a-f]{8}\.json\.gz$/);
  assert.match(second.snapshotPath, /spec\.ts--Login-works-[0-9a-f]{8}\.json\.gz$/);

  // Both bundles survive on disk — neither clobbered the other.
  const p1 = JSON.parse(gunzipSync(readFileSync(first.snapshotPath)).toString("utf8"));
  const p2 = JSON.parse(gunzipSync(readFileSync(second.snapshotPath)).toString("utf8"));
  assert.ok(p1.steps[0].html.includes(firstBody.toString("base64")), "FIRST's bundle survives");
  assert.ok(p2.steps[0].html.includes(secondBody.toString("base64")), "SECOND's bundle survives");
});

test("the SAME test (same raw title) resolves to one stable file across calls — its retries don't pile up files", () => {
  const buildOneStepTrace = (sha1: string, body: Buffer): string => {
    const zip = new AdmZip();
    const lines = [
      { type: "screencastFrame", sha1, timestamp: 150, width: 100, height: 100 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 200 },
    ];
    zip.addFile("0-trace.trace", Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n"), "utf8"));
    zip.addFile(`resources/${sha1}.jpeg`, body);
    const p = join(tmpRoot, `trace-${sha1}.zip`);
    zip.writeZip(p);
    return p;
  };

  const outputDir = join(tmpRoot, "stable");
  const a = parseAndSaveTrace(buildOneStepTrace("aaa", Buffer.from("ATTEMPT1")), "flaky test", "spec.ts", outputDir);
  const b = parseAndSaveTrace(buildOneStepTrace("bbb", Buffer.from("ATTEMPT2")), "flaky test", "spec.ts", outputDir);

  assert.ok(a.snapshotPath && b.snapshotPath);
  assert.equal(a.snapshotPath, b.snapshotPath,
    "identical raw title → identical (stable) path; last write wins for the same test");
  const parsed = JSON.parse(gunzipSync(readFileSync(b.snapshotPath)).toString("utf8"));
  assert.ok(parsed.steps[0].html.includes(Buffer.from("ATTEMPT2").toString("base64")),
    "the surviving bundle is the latest attempt");
});

// ─── cleanSelector ──────────────────────────────────────────────────────────
// Playwright internal selector syntax → readable display form. Regressions
// here garble the step labels shown on the dashboard.

test("cleanSelector: testid strips the internal: prefix and trailing strict flag", () => {
  assert.equal(cleanSelector('internal:testid=[data-testid="login"]s'), '[data-testid="login"]');
  assert.equal(cleanSelector('internal:testid=[data-testid="login"]'), '[data-testid="login"]');
});

test("cleanSelector: role with a name keeps its bracket; bare role loses internal: prefix", () => {
  assert.equal(cleanSelector('internal:role=button[name="Save"]'), 'role=button[name="Save"]');
  // Regression: a bracket-less getByRole("button") used to keep the
  // internal: prefix because the old regex required a following `[`.
  assert.equal(cleanSelector("internal:role=button"), "role=button");
});

test("cleanSelector: text with an apostrophe inside double quotes is NOT truncated", () => {
  // Regression: `[^"']` stopped at the apostrophe → produced "text=it".
  assert.equal(cleanSelector(`internal:text="it's done"s`), "text=it's done");
});

test("cleanSelector: text strips the trailing strict/case-insensitive flag", () => {
  // Regression: trailing `s` survived → "text=it workss".
  assert.equal(cleanSelector('internal:text="it works"s'), "text=it works");
  assert.equal(cleanSelector('internal:text="case"i'), "text=case");
  assert.equal(cleanSelector('internal:text="no flag"'), "text=no flag");
});

test("cleanSelector: single-quoted text keeps an inner double quote", () => {
  assert.equal(cleanSelector(`internal:text='say "hi"'`), 'text=say "hi"');
});

test("cleanSelector: a plain CSS selector passes through untouched", () => {
  assert.equal(cleanSelector("button.primary"), "button.primary");
  assert.equal(cleanSelector("#email"), "#email");
});

// Regression: the value captures must stay length-bounded so matching is
// linear. The unbounded `[^\]]+` / `[^"]*` form was polynomial (O(n²)) under
// the global flag, and `sel` comes from an untrusted trace — a crafted
// selector that repeats the prefix without a terminator took seconds. The
// tight timeout fails fast if anyone drops the bound back to `+`/`*`.
test("cleanSelector: an adversarial unterminated selector is handled in linear time", { timeout: 2000 }, () => {
  const adversarial = "internal:testid=[".repeat(50_000); // no closing ']' → no match
  // No closing bracket means nothing to strip; the point is that it returns
  // promptly rather than hanging.
  assert.equal(cleanSelector(adversarial), adversarial);
});

// --- Phase 1: per-step console + network enrichment ---

// A two-step trace (goto @100, click @300) with screencast frames so both
// actions produce snapshot steps. Optional network lines go in the .network
// file. Console lines are inline in the action trace.
function twoStepTrace(extraTraceLines: any[] = [], networkLines?: any[]): string {
  return buildTraceZip(
    [
      { type: "context-options", options: { viewport: { width: 1280, height: 720 } } },
      { type: "screencastFrame", sha1: "f1", timestamp: 160, width: 1280, height: 720 },
      { type: "screencastFrame", sha1: "f2", timestamp: 330, width: 1280, height: 720 },
      { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
      { type: "after", callId: "c1", endTime: 160 },
      { type: "before", callId: "c2", class: "Locator", method: "click", params: { selector: "button#go" }, startTime: 300 },
      { type: "after", callId: "c2", endTime: 330 },
      ...extraTraceLines,
    ],
    { "f1.jpeg": fakeJpeg, "f2.jpeg": fakeJpeg },
    networkLines,
  );
}

test("console events attach to the step active at their time, with normalized levels", () => {
  const path = twoStepTrace([
    { type: "console", messageType: "log", text: "navigating", time: 150 },     // step 0 (started @100)
    { type: "console", messageType: "warning", text: "deprecated api", time: 320 }, // step 1 (started @300)
    { type: "console", messageType: "error", text: "boom", time: 340 },         // step 1
  ]);

  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.ok(snapshotBundle);
  assert.equal(snapshotBundle!.steps.length, 2);

  assert.deepEqual(snapshotBundle!.steps[0].console, [{ level: "log", text: "navigating" }]);
  // "warning" must be folded to "warn"; both step-1 lines land on step 1 in order.
  assert.deepEqual(snapshotBundle!.steps[1].console, [
    { level: "warn", text: "deprecated api" },
    { level: "error", text: "boom" },
  ]);
});

test("network entries from the .network file attach to the active step", () => {
  const path = twoStepTrace([], [
    netEntry("GET", "/api/a", 200, 140),  // step 0
    netEntry("POST", "/api/b", 500, 310), // step 1
  ]);

  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.ok(snapshotBundle);
  assert.deepEqual(snapshotBundle!.steps[0].network, [{ method: "GET", url: "/api/a", status: 200 }]);
  assert.deepEqual(snapshotBundle!.steps[1].network, [{ method: "POST", url: "/api/b", status: 500 }]);
});

test("a status of -1 (request never completed) is omitted, not emitted as -1", () => {
  const path = twoStepTrace([], [netEntry("GET", "/api/pending", -1, 140)]);
  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.deepEqual(snapshotBundle!.steps[0].network, [{ method: "GET", url: "/api/pending" }]);
  assert.ok(!("status" in snapshotBundle!.steps[0].network![0]));
});

test("events before the first step's start time fall to step 0", () => {
  const path = twoStepTrace(
    [{ type: "console", messageType: "log", text: "very early", time: 10 }],   // before step 0 (@100)
    [netEntry("GET", "/early", 204, 5)],
  );
  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.deepEqual(snapshotBundle!.steps[0].console, [{ level: "log", text: "very early" }]);
  assert.deepEqual(snapshotBundle!.steps[0].network, [{ method: "GET", url: "/early", status: 204 }]);
});

test("steps with no console/network leave both fields absent (backward-compatible)", () => {
  const path = twoStepTrace(); // no console lines, no network file
  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  for (const step of snapshotBundle!.steps) {
    assert.equal(step.console, undefined);
    assert.equal(step.network, undefined);
  }
});

test("per-step console is capped at MAX_CONSOLE_PER_STEP (100)", () => {
  const noisy = Array.from({ length: 150 }, (_, n) => (
    { type: "console", messageType: "log", text: `line ${n}`, time: 320 } // all land on step 1
  ));
  const path = twoStepTrace(noisy);
  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.equal(snapshotBundle!.steps[1].console!.length, 100);
  // The cap keeps the FIRST 100 (chronological), so line 0 survives, line 149 is dropped.
  assert.equal(snapshotBundle!.steps[1].console![0].text, "line 0");
});

test("per-step network is capped at MAX_NETWORK_PER_STEP (50)", () => {
  const flood = Array.from({ length: 80 }, (_, n) => netEntry("GET", `/r/${n}`, 200, 310));
  const path = twoStepTrace([], flood);
  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.equal(snapshotBundle!.steps[1].network!.length, 50);
});

test("older trace layout (network in a *-network.trace file) is still read", () => {
  // Pre-1.59 builds named the network file "*-network.trace" rather than
  // "*.network". The collector accepts both; assert the legacy shape works.
  const zip = new AdmZip();
  zip.addFile("0-trace.trace", Buffer.from([
    { type: "context-options", options: { viewport: { width: 800, height: 600 } } },
    { type: "screencastFrame", sha1: "f1", timestamp: 160, width: 800, height: 600 },
    { type: "before", callId: "c1", class: "Page", method: "goto", params: { url: "/" }, startTime: 100 },
    { type: "after", callId: "c1", endTime: 160 },
  ].map((l) => JSON.stringify(l)).join("\n"), "utf8"));
  zip.addFile("0-trace-network.trace", Buffer.from(JSON.stringify(netEntry("GET", "/legacy", 200, 140)), "utf8"));
  zip.addFile("resources/f1.jpeg", fakeJpeg);
  const path = join(tmpRoot, "trace.zip");
  zip.writeZip(path);

  const { snapshotBundle } = parseTrace(path, "t", "t.spec.ts");
  assert.deepEqual(snapshotBundle!.steps[0].network, [{ method: "GET", url: "/legacy", status: 200 }]);
});
