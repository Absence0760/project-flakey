import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

import {
  state,
  appendStep,
  resetState,
  capHtml,
  getMaxHtmlBytes,
  getMaxBundleBytes,
  isEnabled,
  markGherkinStep,
} from "../shared.ts";

// shared.ts reads Cypress.env(...) at runtime. In a Node test runner
// there is no Cypress global; stub a minimal one before the module's
// functions read it.
type CyEnv = (key: string) => unknown;
declare global {
  // eslint-disable-next-line no-var
  var Cypress: { env: CyEnv } | undefined;
}

let cyEnvOverrides: Record<string, unknown> = {};
globalThis.Cypress = {
  env: (key: string) => cyEnvOverrides[key],
};

beforeEach(() => {
  cyEnvOverrides = {};
  resetState();
});

test("isEnabled() reads Cypress.env('FLAKEY_SNAPSHOTS_ENABLED') as a boolean", () => {
  assert.equal(isEnabled(), false, "default is false");
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  assert.equal(isEnabled(), true);
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = "true";
  assert.equal(isEnabled(), false, "string 'true' must NOT be treated as enabled — only the boolean true");
});

test("getMaxHtmlBytes() defaults to 2 MB and accepts a numeric override", () => {
  assert.equal(getMaxHtmlBytes(), 2 * 1024 * 1024);
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = 100_000;
  assert.equal(getMaxHtmlBytes(), 100_000);
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = "50000";
  assert.equal(getMaxHtmlBytes(), 50_000, "string-typed overrides should coerce to number");
});

test("getMaxHtmlBytes() falls back to default for non-finite or non-positive overrides", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = -1;
  assert.equal(getMaxHtmlBytes(), 2 * 1024 * 1024);
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = "abc";
  assert.equal(getMaxHtmlBytes(), 2 * 1024 * 1024);
});

test("getMaxBundleBytes() defaults to 64 MB and respects override", () => {
  assert.equal(getMaxBundleBytes(), 64 * 1024 * 1024);
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES = 500;
  assert.equal(getMaxBundleBytes(), 500);
});

test("capHtml() returns html unchanged below the cap; replaces with placeholder above it", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = 100;
  const small = "<html>".padEnd(50, "x") + "</html>";
  assert.equal(capHtml(small), small);

  const big = "x".repeat(200);
  const out = capHtml(big);
  assert.match(out, /data-flakey-skipped="true"/, "oversize HTML should be replaced by the placeholder");
  assert.equal(state.cappedCount, 1, "cap should bump cappedCount");
});

test("appendStep() ring-buffer caps at 300 steps and keeps bundleBytes accounting in sync", () => {
  // Push 305 steps with deterministic html sizes.
  for (let i = 0; i < 305; i++) {
    appendStep({
      index: i,
      commandName: "get",
      commandMessage: String(i),
      timestamp: i * 10,
      html: "x".repeat(100),
      scrollX: 0,
      scrollY: 0,
    });
  }
  // Ring buffer caps at 300 — we should have evicted the oldest 5.
  assert.equal(state.steps.length, 300);
  assert.equal(state.steps[0].index, 5, "oldest 5 steps should have been evicted FIFO");
  // bundleBytes = 300 × 100.
  assert.equal(state.bundleBytes, 300 * 100);
});

test("enforceBundleSize() evicts FIFO until bundleBytes ≤ maxBundleBytes", () => {
  // Force the aggregate cap low so this test stays fast.
  cyEnvOverrides.FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES = 250;
  for (let i = 0; i < 10; i++) {
    appendStep({
      index: i,
      commandName: "get",
      commandMessage: String(i),
      timestamp: 0,
      html: "x".repeat(100),
      scrollX: 0,
      scrollY: 0,
    });
  }
  // After appendStep + enforceBundleSize each push, total should ≤ 250.
  assert.ok(state.bundleBytes <= 250, `expected bundleBytes ≤ 250 but got ${state.bundleBytes}`);
  assert.ok(state.evictedCount > 0, "evictedCount should reflect the FIFO drops");
});

test("resetState() zeroes everything and stamps a fresh testStartTime", () => {
  appendStep({
    index: 0,
    commandName: "x",
    commandMessage: "y",
    timestamp: 0,
    html: "abc",
    scrollX: 0,
    scrollY: 0,
  });
  state.cappedCount = 5;
  state.evictedCount = 7;
  const before = Date.now();
  resetState();
  const after = Date.now();

  assert.equal(state.steps.length, 0);
  assert.equal(state.bundleBytes, 0);
  assert.equal(state.commandIndex, 0);
  assert.equal(state.cappedCount, 0);
  assert.equal(state.evictedCount, 0);
  assert.ok(state.testStartTime >= before && state.testStartTime <= after);
});

// markGherkinStep — the deduped step-boundary marker shared by the support
// detector and the optional ./cucumber BeforeStep hook. (pushStep no-ops here
// because there's no app document in Node, so we assert the dedup contract via
// the return value + state.lastGherkinStepId, which is the logic that matters.)

test("markGherkinStep emits once per step id and dedupes the same id (cross-source safe)", () => {
  assert.equal(markGherkinStep("s1", "Context", "the user logs in"), true, "a new step is marked");
  assert.equal(state.lastGherkinStepId, "s1");
  // Same id again — e.g. the support detector firing after BeforeStep already
  // marked this step — must be a no-op so the bundle has no duplicate marker.
  assert.equal(markGherkinStep("s1", "Context", "the user logs in"), false, "same id must not re-mark");
  assert.equal(markGherkinStep("s2", "Action", "the user clicks save"), true, "the next step is marked");
  assert.equal(state.lastGherkinStepId, "s2");
});

test("markGherkinStep ignores a missing id or text", () => {
  assert.equal(markGherkinStep(undefined, "Action", "x"), false);
  assert.equal(markGherkinStep("s1", "Action", undefined), false);
  assert.equal(state.lastGherkinStepId, undefined, "no partial step should set the dedup id");
});

test("resetState clears the Gherkin dedup id so a new test re-marks its first step", () => {
  markGherkinStep("s1", "Context", "login");
  assert.equal(state.lastGherkinStepId, "s1");
  resetState();
  assert.equal(state.lastGherkinStepId, undefined);
  assert.equal(markGherkinStep("s1", "Context", "login"), true, "the same id in a NEW test must re-mark");
});
