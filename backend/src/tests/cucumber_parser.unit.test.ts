/**
 * Cucumber `.feature` parser unit tests.
 *
 * The parser feeds POST /manual-tests/import-features which bulk-creates
 * manual test rows from feature files committed alongside the
 * automation.  It's a hand-rolled state machine over raw source lines —
 * a likely place for subtle bugs around docstrings, scenario outlines,
 * tag inheritance, and Background steps.
 *
 * No server spawn — pure function calls against parseFeature() and
 * scenarioToManualSteps().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeature, scenarioToManualSteps } from "../cucumber-parser.js";

// ── Empty / minimal input ────────────────────────────────────────────────

test("parseFeature: empty string returns empty feature", () => {
  const f = parseFeature("");
  assert.equal(f.name, "");
  assert.equal(f.scenarios.length, 0);
});

test("parseFeature: only comments returns empty feature", () => {
  const f = parseFeature("# just a comment\n# another\n");
  assert.equal(f.scenarios.length, 0);
});

test("parseFeature: Feature: with no scenarios captures the name and description", () => {
  const f = parseFeature(`Feature: Login flow

This is the description of the feature.
It can span multiple lines.
`);
  assert.equal(f.name, "Login flow");
  assert.ok(f.description.includes("description of the feature"));
  assert.equal(f.scenarios.length, 0);
});

// ── Single scenario ──────────────────────────────────────────────────────

test("parseFeature: single Scenario with Given/When/Then steps", () => {
  const f = parseFeature(`Feature: F

Scenario: Successful login
  Given I am on the login page
  When I enter valid credentials
  Then I should see the dashboard
`);
  assert.equal(f.scenarios.length, 1);
  const s = f.scenarios[0];
  assert.equal(s.name, "Successful login");
  assert.equal(s.steps.length, 3);
  assert.equal(s.steps[0].keyword, "Given");
  assert.equal(s.steps[1].keyword, "When");
  assert.equal(s.steps[2].keyword, "Then");
  assert.ok(s.steps[2].text.includes("dashboard"));
});

test("parseFeature: And/But chained after Given/When/Then are preserved as keywords", () => {
  const f = parseFeature(`Feature: F

Scenario: Multi-step
  Given X
  And Y
  When Z
  But not W
  Then OK
`);
  const keywords = f.scenarios[0].steps.map((s) => s.keyword);
  assert.deepEqual(keywords, ["Given", "And", "When", "But", "Then"]);
});

// ── Tags ─────────────────────────────────────────────────────────────────

test("parseFeature: tags above Scenario are attached to it", () => {
  const f = parseFeature(`Feature: F

@smoke @auth
Scenario: Login
  Given X
`);
  const s = f.scenarios[0];
  assert.deepEqual(s.tags.sort(), ["@auth", "@smoke"]);
});

test("parseFeature: feature-level tags don't leak into scenario tags", () => {
  // Common drift: implementation accidentally inherits feature tags into
  // scenarios, doubling counts and confusing tag-based filters.
  const f = parseFeature(`@critical
Feature: F

@smoke
Scenario: A
  Given X

Scenario: B
  Given Y
`);
  assert.deepEqual(f.tags, ["@critical"]);
  assert.deepEqual(f.scenarios[0].tags, ["@smoke"]);
  assert.deepEqual(f.scenarios[1].tags, [], "scenario without its own tags should not inherit feature tags");
});

test("parseFeature: tags on multiple lines are accumulated", () => {
  const f = parseFeature(`Feature: F

@a
@b
@c
Scenario: X
  Given X
`);
  assert.deepEqual(f.scenarios[0].tags.sort(), ["@a", "@b", "@c"]);
});

// ── Background ──────────────────────────────────────────────────────────

test("parseFeature: Background steps are captured separately from scenarios", () => {
  const f = parseFeature(`Feature: F

Background:
  Given I am logged in
  And the database is seeded

Scenario: Doing the thing
  When I click X
  Then Y happens
`);
  assert.equal(f.background.length, 2, "background should have 2 steps");
  assert.equal(f.scenarios[0].steps.length, 2, "scenario should NOT include background steps");
});

test("scenarioToManualSteps: prepends Background steps to the scenario steps", () => {
  // The manual-test view should render Background as part of every
  // scenario so testers see the full execution sequence.
  const f = parseFeature(`Feature: F

Background:
  Given a precondition

Scenario: Real thing
  When something happens
  Then verify it
`);
  const steps = scenarioToManualSteps(f, f.scenarios[0]);
  // Background + scenario steps merged.
  assert.ok(steps.length >= 3, `expected at least 3 manual steps, got ${steps.length}`);
  // Steps are {action, data, expected} rows. Given/When go in `action`,
  // Then goes in `expected` — concatenate both columns to assert presence.
  const stepText = steps.map((s) => `${s.action} ${s.expected}`).join(" | ");
  assert.ok(stepText.includes("precondition"), "background step missing from manual test steps");
  assert.ok(stepText.includes("something happens"), "scenario step missing");
  assert.ok(stepText.includes("verify it"), "Then step missing from expected column");
});

// ── Scenario Outline / Examples ─────────────────────────────────────────

test("parseFeature: Scenario Outline expands into one scenario per Examples row", () => {
  const f = parseFeature(`Feature: F

Scenario Outline: Login as <role>
  Given I am a <role>
  When I sign in
  Then I should land on <page>

Examples:
  | role  | page      |
  | admin | dashboard |
  | guest | home      |
`);
  // Outline + 2 example rows → 2 expanded scenarios.
  assert.equal(f.scenarios.length, 2, "Examples table should produce one scenario per row");
  const names = f.scenarios.map((s) => s.name).sort();
  assert.deepEqual(names, ["Login as admin", "Login as guest"]);
  // Step substitution applied.
  const adminScenario = f.scenarios.find((s) => s.name === "Login as admin")!;
  assert.ok(adminScenario.steps.some((st) => st.text.includes("admin")), "outline placeholder not substituted");
  assert.ok(adminScenario.steps.some((st) => st.text.includes("dashboard")), "second placeholder not substituted");
});

test("parseFeature: Scenario Outline with empty Examples produces no scenarios", () => {
  // Edge: if a developer writes `Scenario Outline:` and forgets the
  // Examples table, the parser should silently produce zero scenarios
  // rather than crash.
  const f = parseFeature(`Feature: F

Scenario Outline: Template
  Given I am <role>

Examples:
  | role |
`);
  // Header-only Examples table → 0 expanded scenarios.
  assert.equal(f.scenarios.length, 0);
});

test("parseFeature: tags on Scenario Outline propagate to each expanded scenario", () => {
  const f = parseFeature(`Feature: F

@outline-tag
Scenario Outline: Each <x>
  Given <x>

Examples:
  | x |
  | a |
  | b |
`);
  for (const s of f.scenarios) {
    assert.ok(s.tags.includes("@outline-tag"), `expanded scenario "${s.name}" missing outline tag`);
  }
});

// ── Docstrings + tables ──────────────────────────────────────────────────

test("parseFeature: docstring after a step is captured verbatim", () => {
  const f = parseFeature(`Feature: F

Scenario: With docstring
  Given the following input:
    """
    line one
    line two
      indented line
    """
  Then it works
`);
  const givenStep = f.scenarios[0].steps[0];
  assert.ok(givenStep.docstring, "docstring not attached to step");
  assert.ok(givenStep.docstring!.includes("line one"));
  assert.ok(givenStep.docstring!.includes("indented line"), "docstring indentation should be preserved");
});

test("parseFeature: triple-backtick docstrings (markdown style) work too", () => {
  const f = parseFeature(`Feature: F

Scenario: Backtick
  Given a payload:
    \`\`\`
    {"hello": "world"}
    \`\`\`
  Then verify
`);
  assert.ok(f.scenarios[0].steps[0].docstring?.includes("hello"));
});

test("parseFeature: data table after a step is captured", () => {
  const f = parseFeature(`Feature: F

Scenario: With table
  Given the following users:
    | name  | role  |
    | Alice | admin |
    | Bob   | user  |
  Then proceed
`);
  const step = f.scenarios[0].steps[0];
  assert.ok(step.table, "data table not attached to step");
  assert.equal(step.table!.length, 3, "header + 2 rows");
});

// ── Robustness ──────────────────────────────────────────────────────────

test("parseFeature: trailing whitespace + CRLF line endings", () => {
  const f = parseFeature("Feature: F\r\n\r\nScenario: X\r\n  Given Y   \r\n");
  assert.equal(f.scenarios.length, 1);
  assert.equal(f.scenarios[0].name, "X");
});

test("parseFeature: 100-scenario feature parses in reasonable time", () => {
  const scenarios = Array.from({ length: 100 }, (_, i) => `Scenario: S${i}\n  Given X\n  Then Y\n`).join("\n");
  const start = Date.now();
  const f = parseFeature(`Feature: F\n\n${scenarios}`);
  const dur = Date.now() - start;
  assert.equal(f.scenarios.length, 100);
  assert.ok(dur < 1000, `100-scenario parse took ${dur}ms (should be <1s)`);
});

test("parseFeature: deeply embedded comments inside steps don't break parsing", () => {
  const f = parseFeature(`Feature: F

Scenario: With comments
  # comment between steps
  Given X
  # another comment
  When Y
  Then Z
`);
  assert.equal(f.scenarios[0].steps.length, 3, "inline comments must not eat steps");
});
