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

test("parseFeature: multiple Examples blocks under one Outline all expand", () => {
  // Regression: a Scenario Outline may carry more than one Examples table
  // (each with its own header + rows). An earlier implementation only kept the
  // LAST block — opening a second Examples reset the buffer without expanding
  // the first — so its rows were silently dropped on import.
  const f = parseFeature(`Feature: F

Scenario Outline: Login as <role>
  Given I am a <role>
  Then I land on <page>

Examples: privileged
  | role  | page      |
  | admin | dashboard |
  | owner | console   |

Examples: unprivileged
  | role  | page |
  | guest | home |
`);
  // 2 + 1 rows across two blocks → 3 expanded scenarios, none dropped.
  assert.equal(f.scenarios.length, 3, "all rows from both Examples blocks must expand");
  const names = f.scenarios.map((s) => s.name).sort();
  assert.deepEqual(names, ["Login as admin", "Login as guest", "Login as owner"]);
  // Substitution still applied per row across both blocks.
  const guest = f.scenarios.find((s) => s.name === "Login as guest")!;
  assert.ok(guest.steps.some((st) => st.text === "I land on home"), "second-block row substituted");
});

test("parseFeature: each Examples block may have its own headers", () => {
  // The two blocks below use different column sets; expansion must use the
  // header row of the block the data row belongs to, not a shared one.
  const f = parseFeature(`Feature: F

Scenario Outline: <thing>
  Given <thing> with <detail>

Examples:
  | thing | detail |
  | a     | one    |

Examples:
  | thing | detail |
  | b     | two    |
`);
  assert.equal(f.scenarios.length, 2);
  const a = f.scenarios.find((s) => s.name === "a")!;
  const b = f.scenarios.find((s) => s.name === "b")!;
  assert.equal(a.steps[0].text, "a with one");
  assert.equal(b.steps[0].text, "b with two");
});

test("parseFeature: tags on an Examples block apply to that block, not the next scenario", () => {
  // Regression: tags before an `Examples:` line were left on the pending-tag
  // buffer (Examples didn't consume them), so they leaked onto the NEXT
  // scenario. They should attach to the expanded rows of their own block.
  const f = parseFeature(`Feature: F

@outline
Scenario Outline: Case <n>
  Given <n>

@happy
Examples:
  | n |
  | 1 |

@sad
Examples:
  | n |
  | 2 |

Scenario: Standalone
  Given X
`);
  const one = f.scenarios.find((s) => s.name === "Case 1")!;
  const two = f.scenarios.find((s) => s.name === "Case 2")!;
  const standalone = f.scenarios.find((s) => s.name === "Standalone")!;
  assert.deepEqual(one.tags.sort(), ["@happy", "@outline"], "first block's rows get outline + its own block tag");
  assert.deepEqual(two.tags.sort(), ["@outline", "@sad"], "second block's rows get outline + its own block tag");
  assert.deepEqual(standalone.tags, [], "Examples-block tags must NOT leak onto the following scenario");
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

test("parseFeature: escaped pipes and escape sequences in table cells", () => {
  // Gherkin cell escapes: `\|` → literal pipe, `\\` → literal backslash,
  // `\n` → newline. A naive split("|") would shred any cell containing a pipe.
  const f = parseFeature(`Feature: F

Scenario: Escapes
  Given the following:
    | expr   | note         |
    | a \\| b | one\\ntwo     |
    | c\\\\d   | back\\\\slash  |
`);
  const table = f.scenarios[0].steps[0].table!;
  assert.deepEqual(table[0], ["expr", "note"], "header row intact");
  assert.deepEqual(table[1], ["a | b", "one\ntwo"], "escaped pipe and newline decoded");
  assert.deepEqual(table[2], ["c\\d", "back\\slash"], "escaped backslash decoded");
});

test("parseFeature: a literal '|' inside an Examples cell is preserved", () => {
  // Same escaping applies to Examples rows, which flow through parseTableRow.
  const f = parseFeature(`Feature: F

Scenario Outline: Pipe <op>
  Given I run <op>

Examples:
  | op    |
  | a \\| b |
`);
  assert.equal(f.scenarios.length, 1);
  assert.equal(f.scenarios[0].name, "Pipe a | b", "escaped pipe survives examples substitution");
  assert.equal(f.scenarios[0].steps[0].text, "I run a | b");
});

test("parseFeature: docstring opener with a content type ('\"\"\"json') is recognized", () => {
  // Gherkin allows a media type immediately after the fence; it's metadata we
  // don't retain, but it must still open the docstring (not be mistaken for a
  // step) and the body must be captured.
  const f = parseFeature(`Feature: F

Scenario: Typed docstring
  Given a payload:
    """json
    {"hello": "world"}
    """
  Then it works
`);
  const steps = f.scenarios[0].steps;
  assert.equal(steps.length, 2, "Given + Then — the body must not be parsed as steps");
  assert.ok(steps[0].docstring?.includes('"hello": "world"'), "docstring body captured");
  assert.ok(!steps[0].docstring?.includes("json"), "content-type token is not part of the body");
  assert.equal(steps[1].keyword, "Then");
});

test("parseFeature: a mismatched fence inside a docstring is kept as content", () => {
  // A docstring opened with `"""` only closes on `"""`; a ``` line inside it
  // is body text, not a premature close.
  const f = parseFeature(`Feature: F

Scenario: Nested fence
  Given markdown:
    """
    here is a code block:
    \`\`\`
    code
    \`\`\`
    """
  Then done
`);
  const steps = f.scenarios[0].steps;
  assert.equal(steps.length, 2, "Given + Then, nothing leaked out of the docstring");
  assert.ok(steps[0].docstring?.includes("```"), "inner ``` fence preserved verbatim");
  assert.ok(steps[0].docstring?.includes("code"), "inner code preserved");
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

test("parseFeature: indented whole-line comments are still ignored", () => {
  // Gherkin comments are whole-line regardless of leading whitespace.
  const f = parseFeature(`Feature: F

Scenario: X
    # deeply indented comment
  Given step one
      # another indented comment
  Then step two
`);
  assert.equal(f.scenarios[0].steps.length, 2, "indented full-line comments must not be treated as steps");
  assert.deepEqual(
    f.scenarios[0].steps.map((s) => s.text),
    ["step one", "step two"]
  );
});

test("parseFeature: inline '#' in step text is preserved (hex colors, URL fragments)", () => {
  // Regression: Gherkin only honours whole-line comments. An earlier
  // implementation stripped from the first '#' anywhere on the line, which
  // silently truncated hex colors and URL fragments mid-quote.
  const f = parseFeature(`Feature: Theming

Scenario: Set a hex color
  Given I set the background to "#FF0000"
  When I visit "https://example.com/docs#install"
  Then the swatch shows "#FF0000"
`);
  const texts = f.scenarios[0].steps.map((s) => s.text);
  assert.equal(texts[0], 'I set the background to "#FF0000"', "hex color must survive verbatim");
  assert.equal(texts[1], 'I visit "https://example.com/docs#install"', "URL fragment must survive verbatim");
  assert.equal(texts[2], 'the swatch shows "#FF0000"');
});

test("parseFeature: inline '#' is preserved in names, descriptions, and outline substitution", () => {
  const f = parseFeature(`Feature: Issue #42 tracking

Tracks bug #42 and its #regression.

@channel
Scenario Outline: Tag #<n>
  Given the color <hex>
  Then issue #<n> is resolved

Examples:
  | n | hex     |
  | 1 | #FF0000 |
`);
  assert.equal(f.name, "Issue #42 tracking", "feature name keeps inline '#'");
  assert.ok(f.description.includes("bug #42"), "description keeps inline '#'");
  assert.ok(f.description.includes("#regression"), "description keeps standalone '#word'");
  assert.equal(f.scenarios.length, 1);
  const s = f.scenarios[0];
  assert.equal(s.name, "Tag #1", "outline name substitution keeps literal '#'");
  assert.equal(s.steps[0].text, "the color #FF0000", "examples cell with '#' substituted verbatim");
  assert.equal(s.steps[1].text, "issue #1 is resolved", "placeholder adjacent to '#' substituted correctly");
});
