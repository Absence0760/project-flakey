/**
 * Webhook formatter unit tests — robustness against weird inputs.
 *
 * formatPayload() runs once per webhook delivery; if it throws, the
 * dispatch loop swallows it (see src/webhooks.ts) but the user just
 * sees nothing arrive.  More commonly: a formatter returning malformed
 * JSON that Slack/Teams/Discord rejects, with no clear error.
 *
 * Each formatter is exercised with:
 *  - a minimal payload (no flaky/new failures, empty failed_tests)
 *  - a hostile payload (markdown special chars, very long strings,
 *    null error_message, multi-line stack traces in test titles)
 *  - the flaky.detected variant (which has a different shape)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPayload, type WebhookRunPayload } from "../webhook-formatters.js";

const PLATFORMS = ["slack", "teams", "discord", "generic"] as const;

function basePayload(overrides: Partial<WebhookRunPayload> = {}): WebhookRunPayload {
  return {
    event: "run.failed",
    run: {
      id: 42,
      suite_name: "smoke",
      branch: "main",
      commit_sha: "abc123def456",
      duration_ms: 65_500,
      total: 10,
      passed: 8,
      failed: 2,
      skipped: 0,
      pending: 0,
      url: "http://localhost:7777/runs/42",
    },
    failed_tests: [
      { full_title: "Login > should accept valid creds", error_message: "Expected true got false", spec_file: "login.cy.ts" },
      { full_title: "Logout > should clear session", error_message: null, spec_file: "logout.cy.ts" },
    ],
    trend: "✅✅❌✅❌",
    ...overrides,
  };
}

// ── Smoke: each platform handles a minimal payload ───────────────────────

for (const platform of PLATFORMS) {
  test(`${platform}: minimal payload returns serializable JSON`, () => {
    const out = formatPayload(platform, basePayload());
    // Must be JSON-serializable — Slack/Teams reject anything that
    // can't round-trip through JSON.stringify.
    const json = JSON.stringify(out);
    assert.ok(json.length > 0, `${platform}: produced empty output`);
    // Round-trip parse must not throw (catches circular refs / NaN /
    // undefined-as-value that would silently produce malformed JSON).
    const parsed = JSON.parse(json);
    assert.ok(parsed !== null && typeof parsed === "object", `${platform}: parsed JSON is not an object`);
  });
}

// ── Empty failed_tests list ──────────────────────────────────────────────

for (const platform of PLATFORMS) {
  test(`${platform}: empty failed_tests does not crash the formatter`, () => {
    const out = formatPayload(platform, basePayload({ failed_tests: [] }));
    assert.ok(out, `${platform}: returned nullish`);
    JSON.stringify(out); // throws if non-serializable
  });
}

// ── flaky.detected event variant ─────────────────────────────────────────

for (const platform of PLATFORMS) {
  test(`${platform}: flaky.detected event with flaky_tests array`, () => {
    const out = formatPayload(platform, basePayload({
      event: "flaky.detected",
      flaky_tests: [
        { full_title: "API > should return 200", file_path: "api.cy.ts",
          flaky_rate: 30, flip_count: 4, fail_count: 3, total_runs: 10 },
      ],
    }));
    JSON.stringify(out);
    assert.ok(out);
  });

  test(`${platform}: flaky.detected without flaky_tests array does not crash`, () => {
    const out = formatPayload(platform, basePayload({
      event: "flaky.detected",
      flaky_tests: undefined,
    }));
    JSON.stringify(out);
    assert.ok(out);
  });
}

// ── new.failures event variant ───────────────────────────────────────────

for (const platform of PLATFORMS) {
  test(`${platform}: new.failures event with new_failures array`, () => {
    const out = formatPayload(platform, basePayload({
      event: "new.failures",
      new_failures: [
        { full_title: "Foo > regressed", error_message: "regressed!", spec_file: "foo.cy.ts" },
      ],
    }));
    JSON.stringify(out);
    assert.ok(out);
  });
}

// ── Hostile inputs ───────────────────────────────────────────────────────

for (const platform of PLATFORMS) {
  test(`${platform}: markdown / backtick / pipe in test names does not break payload`, () => {
    // These chars all have meaning in Slack mrkdwn, Teams Markdown, and
    // GitHub-style issue templates.  The formatter should either escape
    // them or pass them through verbatim — never produce malformed
    // output that the receiving platform rejects.
    const out = formatPayload(platform, basePayload({
      failed_tests: [
        {
          full_title: "Test with `backticks` and **bold** and | pipes |",
          error_message: "Error: <script>alert(1)</script>",
          spec_file: "evil.cy.ts",
        },
      ],
    }));
    const json = JSON.stringify(out);
    // The dangerous content must be encoded as part of the JSON string
    // value, not break out into a different field.  Simplest invariant:
    // the output is valid parseable JSON.
    JSON.parse(json);
  });

  test(`${platform}: extremely long test name does not OOM the formatter`, () => {
    const longTitle = "x".repeat(50_000);
    const out = formatPayload(platform, basePayload({
      failed_tests: [{ full_title: longTitle, error_message: null, spec_file: "big.cy.ts" }],
    }));
    const json = JSON.stringify(out);
    // Slack's block kit limits text fields to 3000 chars.  We don't
    // assert truncation per se — just that the formatter completes
    // without OOM/timeout and produces parseable JSON.
    JSON.parse(json);
  });

  test(`${platform}: null error_message rendered safely`, () => {
    const out = formatPayload(platform, basePayload({
      failed_tests: [{
        full_title: "T", error_message: null, spec_file: "s.cy.ts",
      }],
    }));
    const json = JSON.stringify(out);
    JSON.parse(json);
    // The literal string "null" should not appear as the rendered error
    // message.  This is a pet-peeve UX bug — null becomes the string
    // "null" if naively interpolated.
    assert.ok(!json.includes('"null"'), `${platform}: null error_message rendered as literal "null"`);
  });

  test(`${platform}: zero failures (run.passed event) does not crash`, () => {
    const out = formatPayload(platform, basePayload({
      event: "run.passed",
      run: { ...basePayload().run, total: 10, passed: 10, failed: 0, skipped: 0 },
      failed_tests: [],
    }));
    JSON.stringify(out);
    assert.ok(out);
  });
}

// ── Unknown platform falls through to generic ────────────────────────────

test("formatPayload: unknown platform falls through to generic format", () => {
  const out = formatPayload("not-a-real-platform", basePayload()) as { text?: string };
  assert.ok(out.text, "unknown platform should produce the generic shape with a text field");
});

test("formatPayload: empty platform string falls through to generic format", () => {
  const out = formatPayload("", basePayload()) as { text?: string };
  assert.ok(out.text);
});
