/**
 * JUnit parser unit tests.
 *
 * Coverage for parseJUnit() focused on the cross-runner JUnit quirks that the
 * realistic-fixture tests in parsers_realistic.unit.test.ts don't pin down at
 * the per-test/metadata level. JUnit XML from Surefire/TestNG/NUnit carries:
 *   - <error> vs <failure> — both must map to status "failed", and the
 *     element's @type attribute must be preserved as metadata.error_type.
 *   - system-out / system-err — kept as metadata.stdout/stderr, capped to the
 *     LAST 100 lines (a noisy log must not blow up the row).
 *   - <properties><property name= value=/> — folded into metadata.properties,
 *     including a property whose @value is empty string.
 *
 * These exercise parseJUnit on hand-built XML so each behavior is isolated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJUnit } from "../normalizers/junit.js";
import type { NormalizedRun } from "../types.js";

const META: NormalizedRun["meta"] = {
  suite_name: "smoke",
  branch: "main",
  commit_sha: "abc",
  ci_run_id: "",
  reporter: "junit",
  started_at: "",
  finished_at: "",
  environment: "",
};

// ── <error> vs <failure> → failed, error_type preserved ───────────────────

test("junit: <error> with a type attribute maps to failed and preserves error_type", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="boom" classname="com.acme.Svc" time="0.25">
    <error type="java.lang.NullPointerException" message="npe at line 7">at com.acme.Svc.run(Svc.java:7)</error>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const t = out.specs[0].tests[0];

  assert.equal(t.status, "failed", "<error> must classify as failed");
  assert.equal(out.stats.failed, 1);
  assert.equal((t.metadata as Record<string, unknown>).error_type, "java.lang.NullPointerException");
  // message comes from @message, stack from the text body (distinct → kept).
  assert.equal(t.error?.message, "npe at line 7");
  assert.equal(t.error?.stack, "at com.acme.Svc.run(Svc.java:7)");
});

test("junit: <failure> with a type attribute maps to failed and preserves error_type", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="assertion" classname="C" time="0.1">
    <failure type="org.junit.ComparisonFailure" message="expected 1 but was 2"/>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const t = out.specs[0].tests[0];

  assert.equal(t.status, "failed", "<failure> must classify as failed");
  assert.equal(out.stats.failed, 1);
  assert.equal((t.metadata as Record<string, unknown>).error_type, "org.junit.ComparisonFailure");
  assert.equal(t.error?.message, "expected 1 but was 2");
});

test("junit: <failure> without a type attribute omits error_type entirely", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="bare" classname="C">
    <failure message="just failed"/>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const t = out.specs[0].tests[0];

  assert.equal(t.status, "failed");
  assert.equal(
    t.metadata && (t.metadata as Record<string, unknown>).error_type,
    undefined,
    "no @type → no error_type key",
  );
});

test("junit: string-form <failure> (no attributes) still fails, no error_type", () => {
  // Some runners emit <failure>text</failure> with no @type/@message; the
  // parser sees a bare string. Must still be failed with the text as message.
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="stringfail" classname="C">
    <failure>boom happened</failure>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const t = out.specs[0].tests[0];

  assert.equal(t.status, "failed");
  assert.equal(t.error?.message, "boom happened");
  assert.equal(
    t.metadata && (t.metadata as Record<string, unknown>).error_type,
    undefined,
  );
});

// ── system-out / system-err → last 100 lines retained ──────────────────────

test("junit: system-out with >100 lines keeps only the LAST 100, in order", () => {
  const lines = Array.from({ length: 130 }, (_, i) => `line${i}`).join("\n");
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="noisy" classname="C">
    <system-out>${lines}</system-out>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const stdout = (out.specs[0].tests[0].metadata as Record<string, unknown>).stdout as string[];

  assert.equal(stdout.length, 100, "capped at 100 lines");
  // Direction check: the TAIL is retained — line30..line129, not line0..line99.
  assert.equal(stdout[0], "line30", "oldest retained line is the 30th");
  assert.equal(stdout[stdout.length - 1], "line129", "newest line is kept");
});

test("junit: system-err with >100 lines also keeps only the LAST 100", () => {
  const lines = Array.from({ length: 105 }, (_, i) => `err${i}`).join("\n");
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="noisy" classname="C">
    <system-err>${lines}</system-err>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const stderr = (out.specs[0].tests[0].metadata as Record<string, unknown>).stderr as string[];

  assert.equal(stderr.length, 100);
  assert.equal(stderr[0], "err5");
  assert.equal(stderr[stderr.length - 1], "err104");
});

test("junit: short system-out (<100 lines) is retained in full", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="quiet" classname="C">
    <system-out>only one</system-out>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const stdout = (out.specs[0].tests[0].metadata as Record<string, unknown>).stdout as string[];

  assert.deepEqual(stdout, ["only one"]);
});

test("junit: suite-level system-out falls back to the test when test has none", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <system-out>suite log line</system-out>
  <testcase name="t" classname="C"/>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const stdout = (out.specs[0].tests[0].metadata as Record<string, unknown>).stdout as string[];

  assert.deepEqual(stdout, ["suite log line"], "test inherits suite-level system-out");
});

// ── properties → metadata.properties (incl. empty @value) ───────────────────

test("junit: properties parse into metadata, with empty @value preserved as ''", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="t" classname="C">
    <properties>
      <property name="env" value="ci"/>
      <property name="region" value="us-east-1"/>
      <property name="empty" value=""/>
    </properties>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const props = (out.specs[0].tests[0].metadata as Record<string, unknown>).properties as Record<string, string>;

  assert.deepEqual(props, { env: "ci", region: "us-east-1", empty: "" });
});

test("junit: a single <property> (not an array) is still parsed", () => {
  // fast-xml-parser collapses a lone child to an object, not an array — the
  // normalizer's toArray() must handle both shapes.
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="t" classname="C">
    <properties>
      <property name="solo" value="value"/>
    </properties>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const props = (out.specs[0].tests[0].metadata as Record<string, unknown>).properties as Record<string, string>;

  assert.deepEqual(props, { solo: "value" });
});

test("junit: a property missing @name is dropped (no undefined key)", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1">
  <testcase name="t" classname="C">
    <properties>
      <property value="orphan"/>
      <property name="kept" value="yes"/>
    </properties>
  </testcase>
</testsuite>`;
  const out = parseJUnit(xml, META);
  const props = (out.specs[0].tests[0].metadata as Record<string, unknown>).properties as Record<string, string>;

  assert.deepEqual(props, { kept: "yes" }, "nameless property contributes no key");
});

// ── timestamp / time robustness: never throw on garbage time values ───────
// parseJUnit is deliberately defensive ("rather record an empty run than 500 a
// CI pipeline"), but the finished_at math used raw parseFloat + new Date()
// without the NaN guard parseSeconds/playwright.ts already apply. A non-numeric
// time= or a garbage timestamp= produced new Date(NaN).toISOString() → a thrown
// RangeError that 500'd the upload. These pin the representable-ISO invariant.

test("junit: a non-numeric testsuites time= does not throw and yields a representable finished_at", () => {
  const xml = `<?xml version="1.0"?>
<testsuites time="not-a-number">
  <testsuite name="S" tests="1">
    <testcase name="t" classname="C" time="0.1"/>
  </testsuite>
</testsuites>`;
  let out!: NormalizedRun;
  assert.doesNotThrow(() => { out = parseJUnit(xml, META); }, "a bad testsuites time= must not crash the parser");
  assert.doesNotThrow(() => new Date(out.meta.finished_at).toISOString(), "finished_at must be a representable ISO string");
  assert.equal(out.stats.total, 1, "the run is still recorded, not dropped");
});

test("junit: a garbage testsuite timestamp= does not throw and yields a representable finished_at", () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="S" tests="1" timestamp="yesterday-ish">
  <testcase name="t" classname="C" time="0.5"/>
</testsuite>`;
  let out!: NormalizedRun;
  assert.doesNotThrow(() => { out = parseJUnit(xml, META); }, "a bad timestamp= must not crash the parser");
  assert.doesNotThrow(() => new Date(out.meta.started_at).toISOString(), "started_at must be a representable ISO string");
  assert.doesNotThrow(() => new Date(out.meta.finished_at).toISOString(), "finished_at must be a representable ISO string");
  assert.equal(out.stats.total, 1);
});

test("junit: a valid testsuites time= still drives the run duration", () => {
  // Guard the fix didn't regress the happy path: a numeric time= is honoured.
  const xml = `<?xml version="1.0"?>
<testsuites time="2.5">
  <testsuite name="S" tests="1">
    <testcase name="t" classname="C" time="2.5"/>
  </testsuite>
</testsuites>`;
  const out = parseJUnit(xml, META);
  const span = new Date(out.meta.finished_at).getTime() - new Date(out.meta.started_at).getTime();
  assert.equal(span, 2500, "finished_at - started_at must reflect the 2.5s testsuites time");
});
