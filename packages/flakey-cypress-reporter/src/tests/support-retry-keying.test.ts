/**
 * Support file (browser realm) — retry-trail keying.
 *
 * The support file accumulates a per-test error trail across retries so a
 * retried-then-passing test still carries every attempt's error. The trail
 * lives in module-level state that outlives a single test, so its key must
 * uniquely identify a test — keyed by leaf title alone, a clean passing test
 * would inherit an earlier same-named test's error trail (false-positive
 * `retry_errors`).
 *
 * These tests don't run Cypress. They install minimal Cypress/cy/beforeEach/
 * afterEach globals BEFORE importing support.ts (which registers its hooks at
 * import time), then drive the captured afterEach with mocked test state and
 * assert on the `flakey:saveFailureContext` task payloads.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

interface TaskCall { name: string; data: any }
const taskCalls: TaskCall[] = [];

let registeredBeforeEach: (() => void) | undefined;
let registeredAfterEach: (() => void) | undefined;

// Mutable "current test" state the afterEach reads through the Cypress global.
let current: {
  title: string;
  fullTitle: string;
  state: "passed" | "failed";
  err?: { message: string; stack?: string };
  specRelative: string;
} = { title: "", fullTitle: "", state: "passed", specRelative: "" };

const Cypress: any = {
  on: () => {}, // listeners (log:added, uncaught:exception, …) — irrelevant here
  get spec() {
    return { relative: current.specRelative, name: current.specRelative };
  },
  get currentTest() {
    return {
      title: current.title,
      state: current.state,
      fullTitle: () => current.fullTitle,
      err: current.err,
    };
  },
  state: (key: string) =>
    key === "runnable" ? { state: current.state, err: current.err } : undefined,
};

(globalThis as any).Cypress = Cypress;
(globalThis as any).cy = {
  task: (name: string, data: any) => {
    taskCalls.push({ name, data });
  },
};
(globalThis as any).beforeEach = (cb: () => void) => { registeredBeforeEach = cb; };
(globalThis as any).afterEach = (cb: () => void) => { registeredAfterEach = cb; };

// Import AFTER the globals exist — the module wires its hooks on load.
await import("../support.ts");

// Drive one simulated test through the support file's beforeEach → afterEach.
function runTest(t: {
  title: string;
  fullTitle: string;
  spec: string;
  state: "passed" | "failed";
  errMessage?: string;
}) {
  current = {
    title: t.title,
    fullTitle: t.fullTitle,
    specRelative: t.spec,
    state: t.state,
    err: t.errMessage ? { message: t.errMessage } : undefined,
  };
  registeredBeforeEach!();
  registeredAfterEach!();
}

function lastFailureContext(): any | undefined {
  const calls = taskCalls.filter((c) => c.name === "flakey:saveFailureContext");
  return calls.length ? calls[calls.length - 1].data.failureContext : undefined;
}

test("a passing test does NOT inherit a same-leaf-title earlier test's retry trail (different describe block)", () => {
  taskCalls.length = 0;

  // describe("A") it("works") fails — builds a retry trail under A's full title.
  runTest({ title: "works", fullTitle: "A works", spec: "x.cy.ts", state: "failed", errMessage: "boom in A" });
  const aFc = lastFailureContext();
  assert.ok(aFc?.retry_errors, "the failing test records its own retry trail");
  assert.equal(aFc.retry_errors.length, 1);
  assert.equal(aFc.retry_errors[0].message, "boom in A");

  taskCalls.length = 0;

  // describe("B") it("works") — same leaf title, same spec, but PASSES.
  // With leaf-only keying it would inherit A's trail and ship bogus
  // retry_errors. With spec+fullTitle keying it has no context at all.
  runTest({ title: "works", fullTitle: "B works", spec: "x.cy.ts", state: "passed" });

  const bFailureContextCalls = taskCalls.filter((c) => c.name === "flakey:saveFailureContext");
  assert.equal(bFailureContextCalls.length, 0,
    "a clean pass with a colliding leaf title must ship NO failure context");
});

test("retries of the SAME test accumulate onto one trail (same full title across attempts)", () => {
  taskCalls.length = 0;

  // Two failing attempts of the identical test (same spec + full title).
  runTest({ title: "flaky", fullTitle: "Suite flaky", spec: "y.cy.ts", state: "failed", errMessage: "attempt 0" });
  runTest({ title: "flaky", fullTitle: "Suite flaky", spec: "y.cy.ts", state: "failed", errMessage: "attempt 1" });

  const fc = lastFailureContext();
  assert.equal(fc.retry_errors.length, 2, "both attempts accumulate onto the same trail");
  assert.equal(fc.retry_errors[0].message, "attempt 0");
  assert.equal(fc.retry_errors[1].message, "attempt 1");
  assert.deepEqual(fc.retry_errors.map((e: any) => e.attempt), [0, 1]);
});

test("same full title in two different specs keeps separate trails", () => {
  taskCalls.length = 0;

  runTest({ title: "login", fullTitle: "Auth login", spec: "a.cy.ts", state: "failed", errMessage: "spec-a fail" });

  taskCalls.length = 0;
  // Same describe-path title, different spec, passing → no inherited trail.
  runTest({ title: "login", fullTitle: "Auth login", spec: "b.cy.ts", state: "passed" });

  assert.equal(
    taskCalls.filter((c) => c.name === "flakey:saveFailureContext").length, 0,
    "a passing test in spec b must not inherit spec a's same-titled trail",
  );
});
