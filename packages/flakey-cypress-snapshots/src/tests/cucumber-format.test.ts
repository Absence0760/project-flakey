import { test } from "node:test";
import { strict as assert } from "node:assert";

import { gherkinKeywordForType, gherkinMarkerMessage } from "../cucumber-format.ts";

/**
 * The frontend's strict-pin (issue #26) reads
 * `snapshotSteps[i].commandName === "gherkin"` and substring-matches
 * the gherkin step text inside `commandMessage`. cucumber.ts is the
 * only producer of those markers in the Cypress reporter pipeline, so
 * these tests pin the contract on the producer side: the keyword
 * mapping is stable and the assembled commandMessage starts with a
 * known keyword followed by the step text.
 */

test("gherkinKeywordForType maps Context→Given, Action→When, Outcome→Then", () => {
  assert.equal(gherkinKeywordForType("Context"), "Given");
  assert.equal(gherkinKeywordForType("Action"), "When");
  assert.equal(gherkinKeywordForType("Outcome"), "Then");
});

test("gherkinKeywordForType falls back to 'Step' for unknown types", () => {
  assert.equal(gherkinKeywordForType("Unknown"), "Step");
  assert.equal(gherkinKeywordForType(""), "Step");
  assert.equal(gherkinKeywordForType(undefined), "Step");
  assert.equal(gherkinKeywordForType(null), "Step");
});

test("gherkinMarkerMessage prepends the keyword + a single space, preserving step text verbatim", () => {
  assert.equal(
    gherkinMarkerMessage("Context", "the user is on /login"),
    "Given the user is on /login",
  );
  assert.equal(
    gherkinMarkerMessage("Action", "the user submits the form"),
    "When the user submits the form",
  );
  assert.equal(
    gherkinMarkerMessage("Outcome", "the user lands on /dashboard"),
    "Then the user lands on /dashboard",
  );
});

test("gherkinMarkerMessage uses 'Step' when the type is missing — never produces a leading-space message", () => {
  const out = gherkinMarkerMessage(undefined, "i do something unusual");
  assert.equal(out, "Step i do something unusual");
  // Critical for the viewer's strict-pin: the message must start with
  // a keyword word, not a space, so normalised matching never has to
  // strip a leading separator.
  assert.equal(/^\s/.test(out), false, "marker message must not start with whitespace");
});

test("gherkinMarkerMessage preserves quotes, punctuation, and unicode in the step text — the viewer normalises, not the producer", () => {
  const text = `the user types "café résumé — 你好"`;
  const out = gherkinMarkerMessage("Action", text);
  assert.equal(out, `When ${text}`);
});
