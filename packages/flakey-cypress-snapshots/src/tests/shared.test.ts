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
  // Ring-buffer evictions must be counted too — otherwise a >300-command test
  // reports "0 evicted" while it silently dropped its oldest steps.
  assert.equal(state.evictedCount, 5, "the 5 ring-buffer evictions are surfaced in evictedCount");
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

// --- Phase 3: per-step console + network capture ---

import {
  recordConsole,
  recordNetwork,
  takePending,
  instrumentWindow,
} from "../shared.ts";

test("recordConsole normalizes level and buffers into pendingConsole when enabled", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  recordConsole("error", "boom");
  recordConsole("warning", "deprecated"); // "warning" → "warn"
  recordConsole("log", "hi");
  assert.deepEqual(state.pendingConsole, [
    { level: "error", text: "boom" },
    { level: "warn", text: "deprecated" },
    { level: "log", text: "hi" },
  ]);
});

test("recordConsole / recordNetwork no-op when snapshots are disabled", () => {
  // enabled defaults to false (beforeEach clears overrides)
  recordConsole("error", "boom");
  recordNetwork("GET", "/x", 500);
  assert.equal(state.pendingConsole.length, 0);
  assert.equal(state.pendingNetwork.length, 0);
});

test("recordNetwork omits status when undefined and ignores empty urls", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  recordNetwork("POST", "/api/a", 201);
  recordNetwork("GET", "/api/pending", undefined); // never completed
  recordNetwork("GET", ""); // no url → dropped
  assert.deepEqual(state.pendingNetwork, [
    { method: "POST", url: "/api/a", status: 201 },
    { method: "GET", url: "/api/pending" },
  ]);
});

test("pending buffers are capped (100 console / 50 network) per step window", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  for (let i = 0; i < 150; i++) recordConsole("log", `line ${i}`);
  for (let i = 0; i < 80; i++) recordNetwork("GET", `/r/${i}`, 200);
  assert.equal(state.pendingConsole.length, 100);
  assert.equal(state.pendingNetwork.length, 50);
  assert.equal(state.pendingConsole[0].text, "line 0", "the cap keeps the first N chronologically");
});

test("takePending drains the buffers and contributes no key when empty", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  assert.deepEqual(takePending(), {}, "nothing buffered → empty object (no console/network keys)");
  recordConsole("error", "x");
  recordNetwork("GET", "/y", 404);
  const taken = takePending();
  assert.deepEqual(taken.console, [{ level: "error", text: "x" }]);
  assert.deepEqual(taken.network, [{ method: "GET", url: "/y", status: 404 }]);
  // Buffers are now empty — a second take yields nothing.
  assert.deepEqual(takePending(), {});
});

test("resetState clears the pending console/network buffers", () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  recordConsole("log", "a");
  recordNetwork("GET", "/b", 200);
  resetState();
  assert.equal(state.pendingConsole.length, 0);
  assert.equal(state.pendingNetwork.length, 0);
});

test("appendStep carries console/network fields onto the stored step", () => {
  appendStep({
    index: 0,
    commandName: "click",
    commandMessage: "submit",
    timestamp: 0,
    html: "<html></html>",
    scrollX: 0,
    scrollY: 0,
    console: [{ level: "error", text: "boom" }],
    network: [{ method: "POST", url: "/api/login", status: 401 }],
  });
  assert.deepEqual(state.steps[0].console, [{ level: "error", text: "boom" }]);
  assert.deepEqual(state.steps[0].network, [{ method: "POST", url: "/api/login", status: 401 }]);
});

test("instrumentWindow wraps console + fetch, records to pending, and calls through", async () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  let origErrorCalled = false;
  const win: any = {
    console: {
      log() {}, info() {}, warn() {},
      error() { origErrorCalled = true; },
    },
    fetch: (_url: string) => Promise.resolve({ status: 503 }),
  };

  instrumentWindow(win);

  win.console.error("boom", { a: 1 });
  assert.equal(origErrorCalled, true, "original console.error must still run (we observe, never swallow)");
  assert.deepEqual(state.pendingConsole, [{ level: "error", text: 'boom {"a":1}' }]);

  await win.fetch("/api/x");
  assert.deepEqual(state.pendingNetwork, [{ method: "GET", url: "/api/x", status: 503 }]);
});

test("instrumentWindow records a rejected fetch as a never-completed request (no status)", async () => {
  cyEnvOverrides.FLAKEY_SNAPSHOTS_ENABLED = true;
  const win: any = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    fetch: (_url: string) => Promise.reject(new Error("network down")),
  };
  instrumentWindow(win);
  await assert.rejects(() => win.fetch("/api/down"), /network down/);
  assert.deepEqual(state.pendingNetwork, [{ method: "GET", url: "/api/down" }]);
});

test("instrumentWindow is a no-op when snapshots are disabled (window not wrapped)", async () => {
  // enabled defaults false
  let recorded = false;
  const win: any = {
    console: { log() {}, info() {}, warn() {}, error() { recorded = true; } },
    fetch: (_url: string) => Promise.resolve({ status: 200 }),
  };
  instrumentWindow(win);
  win.console.error("x");
  await win.fetch("/y");
  // console.error still its own original (our wrapper never installed), and
  // nothing buffered.
  assert.equal(state.pendingConsole.length, 0);
  assert.equal(state.pendingNetwork.length, 0);
  assert.equal(recorded, true, "the window's own console.error is untouched when disabled");
});
