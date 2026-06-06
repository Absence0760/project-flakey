/**
 * Jest normalizer — ANSI stripping + error truncation.
 *
 * Client workflow protected: a Jest run fails with ANSI-colored assertion
 * output. The dashboard renders error.message / error.stack as plain text,
 * so the normalizer must strip the escape sequences (otherwise the UI shows
 * raw `\x1b[31m` gibberish) and bound the length (otherwise a megabyte of
 * diff lands in a DB column and blows up the detail view).
 *
 * These are unit-level, pure-function assertions against parseJest — no
 * server, no DB. They complement parsers_realistic.unit.test.ts (which pins
 * the happy-path fixture) by nailing the edge cases of the ANSI regex and the
 * exact 500 / 2000 truncation limits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJest } from "../normalizers/jest.js";
import type { NormalizedRun } from "../types.js";

const META: NormalizedRun["meta"] = {
  suite_name: "test-suite",
  branch: "main",
  commit_sha: "abc",
  ci_run_id: "1",
  started_at: "2026-04-10T00:00:00Z",
  finished_at: "2026-04-10T00:00:01Z",
  reporter: "jest",
};

/** Build a minimal Jest report with one failed test carrying `failureMessages`. */
function reportWithFailure(failureMessage: string): unknown {
  return {
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    startTime: 0,
    success: false,
    wasInterrupted: false,
    testResults: [
      {
        testFilePath: "src/example.test.ts",
        numPassingTests: 0,
        numFailingTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        perfStats: { start: 0, end: 1, runtime: 1, slow: false },
        testResults: [
          {
            ancestorTitles: ["Suite"],
            title: "fails",
            fullName: "Suite fails",
            status: "failed",
            duration: 1,
            failureMessages: [failureMessage],
            failureDetails: [],
            numPassingAsserts: 0,
          },
        ],
      },
    ],
  };
}

/** Pull the single failed test's error out of a parsed report. */
function onlyError(raw: unknown) {
  const out = parseJest(raw, META);
  const test = out.specs.flatMap((s) => s.tests).find((t) => t.status === "failed");
  assert.ok(test, "expected a failed test in the parsed run");
  assert.ok(test!.error, "expected an error on the failed test");
  return test!.error!;
}

const ESC = "";

// ── ANSI stripping ───────────────────────────────────────────────────────

test("jest: a simple ANSI color code is stripped from message and stack", () => {
  // \x1b[31m = red, \x1b[39m = default fg.
  const msg = `${ESC}[31mexpect(received).toBe(expected)${ESC}[39m`;
  const error = onlyError(reportWithFailure(msg));

  assert.equal(error.message, "expect(received).toBe(expected)");
  assert.equal(error.stack, "expect(received).toBe(expected)");
  assert.ok(!error.message!.includes(ESC), "no escape char should survive in message");
  assert.ok(!error.stack!.includes(ESC), "no escape char should survive in stack");
});

test("jest: nested/stacked ANSI codes (bold + red) are fully stripped", () => {
  // Jest emits bold+color as two adjacent SGR sequences: \x1b[1m\x1b[31m.
  const msg = `${ESC}[1m${ESC}[31mAssertionError: nope${ESC}[22m${ESC}[39m`;
  const error = onlyError(reportWithFailure(msg));

  assert.equal(error.message, "AssertionError: nope");
  assert.ok(!error.message!.includes(ESC));
  assert.ok(!error.message!.includes("[1m"), "the numeric code body must go too");
});

test("jest: multiple ANSI sequences spread across one line are all stripped", () => {
  const msg = `${ESC}[2mat ${ESC}[0m${ESC}[36mObject.<anonymous>${ESC}[0m ${ESC}[2m(file.ts:1:1)${ESC}[0m`;
  const error = onlyError(reportWithFailure(msg));

  assert.equal(error.message, "at Object.<anonymous> (file.ts:1:1)");
  assert.ok(!error.message!.includes(ESC));
});

test("jest: an incomplete trailing ANSI sequence does not crash and leaves no escape char", () => {
  // A truncated stream can end mid-escape: "...done\x1b[3" with no final letter.
  // The SGR regex requires a trailing `m`, so the partial sequence won't match
  // the color pattern — but the parser must not throw, and the raw ESC byte
  // must not corrupt the leading content that DID parse cleanly.
  const msg = `${ESC}[32mPASS${ESC}[39m then ${ESC}[3`;
  const error = onlyError(reportWithFailure(msg));

  // The complete sequences around "PASS" and " then " are removed cleanly.
  assert.ok(error.message!.startsWith("PASS then "), `got: ${JSON.stringify(error.message)}`);
  // The dangling, non-SGR partial (`\x1b[3`) is not an `m`-terminated color
  // code, so the normalizer's regex leaves it as-is. That's the documented
  // behavior; what matters for the workflow is it doesn't throw and the
  // well-formed codes are gone. Assert exactly what survives so a regex
  // change that starts eating partials is caught.
  assert.equal(error.message, `PASS then ${ESC}[3`);
});

test("jest: ANSI in a multi-line failure — first line is message, full clean text is stack", () => {
  const raw = [
    `${ESC}[31mexpect(received).toBe(expected)${ESC}[39m`,
    "",
    `${ESC}[32mExpected: 42${ESC}[39m`,
    `${ESC}[31mReceived: 41${ESC}[39m`,
  ].join("\n");
  const error = onlyError(reportWithFailure(raw));

  assert.equal(error.message, "expect(received).toBe(expected)", "message is the cleaned first line only");
  assert.ok(!error.stack!.includes(ESC), "stack is fully de-ANSI'd");
  assert.ok(error.stack!.includes("Expected: 42"), "stack keeps the multi-line diff body");
  assert.ok(error.stack!.includes("Received: 41"));
  assert.ok(error.stack!.includes("\n"), "stack preserves newlines from the multi-line failure");
});

// ── Truncation limits ──────────────────────────────────────────────────────

test("jest: message is truncated to 500 chars (taken after ANSI stripping)", () => {
  // 600 visible 'a's wrapped in a color code. After stripping there are 600
  // chars on the first line; message must be clamped to 500.
  const body = "a".repeat(600);
  const error = onlyError(reportWithFailure(`${ESC}[31m${body}${ESC}[39m`));

  assert.equal(error.message!.length, 500, "message clamps to 500 chars");
  assert.equal(error.message, "a".repeat(500));
});

test("jest: a message at exactly 500 chars is kept whole (no off-by-one truncation)", () => {
  const body = "b".repeat(500);
  const error = onlyError(reportWithFailure(body));

  assert.equal(error.message!.length, 500);
  assert.equal(error.message, body);
});

test("jest: stack is truncated to 2000 chars (taken after ANSI stripping)", () => {
  // 3000 visible chars across the whole (single-line here) message; stack
  // clamps to 2000. Message, being the first line, also clamps to 500.
  const body = "c".repeat(3000);
  const error = onlyError(reportWithFailure(`${ESC}[31m${body}${ESC}[39m`));

  assert.equal(error.stack!.length, 2000, "stack clamps to 2000 chars");
  assert.equal(error.stack, "c".repeat(2000));
  assert.equal(error.message!.length, 500, "message still clamps to 500");
});

test("jest: stripped-then-truncated stack contains no escape bytes even when oversized", () => {
  // Interleave color codes through a long body so a naive truncate-then-strip
  // (wrong order) would leave a dangling ESC. The source strips first, so the
  // 2000-char window is all visible text.
  const chunk = `${ESC}[33m${"d".repeat(50)}${ESC}[39m`;
  const error = onlyError(reportWithFailure(chunk.repeat(60))); // ~3000 visible chars
  assert.equal(error.stack!.length, 2000);
  assert.ok(!error.stack!.includes(ESC), "no escape byte in the truncated stack");
  assert.equal(error.stack, "d".repeat(2000));
});
