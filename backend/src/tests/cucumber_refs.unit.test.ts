/**
 * Unit tests for resolveCucumberRefs() — the stable source_ref assignment used
 * by POST /manual-tests/import-features.
 *
 * source_ref is the upsert key (ON CONFLICT (org_id, source, source_ref)). A
 * Scenario Outline whose name has no <placeholder> expands to many scenarios
 * with the SAME name; without disambiguation they share one ref and overwrite
 * each other on import, leaving a single surviving manual test. These tests
 * pin: unique names are left untouched (existing imports stay stable), and
 * colliding names are split by their Examples row so every row imports.
 *
 * Pure function calls — no server, no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeature } from "../cucumber-parser.js";
import { cucumberRef, resolveCucumberRefs } from "../routes/manual-tests.js";

const FILE = "features/checkout.feature";

test("resolveCucumberRefs: plain scenarios keep their base ref untouched", () => {
  const f = parseFeature(`Feature: F

Scenario: Add to cart
  Given a product

Scenario: Remove from cart
  Given a cart
`);
  const refs = resolveCucumberRefs(FILE, f.scenarios);
  assert.deepEqual(refs, [
    cucumberRef(FILE, "Add to cart"),
    cucumberRef(FILE, "Remove from cart"),
  ]);
});

test("resolveCucumberRefs: outline with a <placeholder> name yields distinct names → refs untouched", () => {
  const f = parseFeature(`Feature: F

Scenario Outline: Checkout as <role>
  Given I am a <role>

Examples:
  | role  |
  | admin |
  | guest |
`);
  const refs = resolveCucumberRefs(FILE, f.scenarios);
  // Names already differ, so no disambiguation — refs are the plain base form.
  assert.deepEqual(refs, [
    cucumberRef(FILE, "Checkout as admin"),
    cucumberRef(FILE, "Checkout as guest"),
  ]);
});

test("resolveCucumberRefs: outline with NO placeholder in the name gets unique refs per row", () => {
  // The bug: every row expands to "Run the suite" → same ref → rows overwrite
  // each other on import. Each must get a distinct, stable ref.
  const f = parseFeature(`Feature: F

Scenario Outline: Run the suite
  Given env <env> at <region>

Examples:
  | env   | region |
  | prod  | us     |
  | stage | eu     |
`);
  const refs = resolveCucumberRefs(FILE, f.scenarios);
  assert.equal(new Set(refs).size, 2, "each expanded row must get a unique ref");
  // Disambiguator is derived from the Examples row values (stable, not just an
  // opaque index).
  assert.ok(refs[0].includes("prod"), "first ref carries its row identity");
  assert.ok(refs[1].includes("stage"), "second ref carries its row identity");
  assert.ok(refs.every((r) => r.startsWith(cucumberRef(FILE, "Run the suite"))));
});

test("resolveCucumberRefs: deterministic across repeated calls on the same feature", () => {
  const f = parseFeature(`Feature: F

Scenario Outline: Smoke
  Given <a>

Examples:
  | a |
  | x |
  | y |
`);
  const a = resolveCucumberRefs(FILE, f.scenarios);
  const b = resolveCucumberRefs(FILE, f.scenarios);
  assert.deepEqual(a, b, "re-import of the same file must produce identical refs");
});

test("resolveCucumberRefs: identical Examples rows still get unique refs via tiebreaker", () => {
  // Degenerate authoring: two identical rows under a no-placeholder outline.
  // Row-value disambiguation alone collides, so a positional tiebreaker kicks
  // in — the refs must still be distinct so neither row overwrites the other.
  const f = parseFeature(`Feature: F

Scenario Outline: Idempotent run
  Given <a>

Examples:
  | a   |
  | dup |
  | dup |
`);
  const refs = resolveCucumberRefs(FILE, f.scenarios);
  assert.equal(refs.length, 2);
  assert.equal(new Set(refs).size, 2, "identical rows must not collapse to one ref");
});

test("resolveCucumberRefs: multiple Examples blocks under one outline all import distinctly", () => {
  // Ties the run-merge-era multi-block fix to the ref layer: every row across
  // both blocks (no placeholder in the name) must get its own ref.
  const f = parseFeature(`Feature: F

Scenario Outline: Deploy
  Given <env>

Examples:
  | env  |
  | prod |
  | dev  |

Examples:
  | env   |
  | stage |
`);
  const refs = resolveCucumberRefs(FILE, f.scenarios);
  assert.equal(f.scenarios.length, 3);
  assert.equal(new Set(refs).size, 3, "all three rows across both blocks must be importable");
});
