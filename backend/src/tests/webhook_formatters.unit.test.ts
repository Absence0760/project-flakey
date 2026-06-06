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

// ── Large-array truncation (Slack payload-size protection) ───────────────
//
// Flakey dispatches flaky.detected / new.failures webhooks to Slack. Slack
// rejects a section block whose text exceeds 3000 chars and renders a huge
// list unusably; the formatter must cap the rendered rows (first 10 + an
// "and N more" overflow line) and keep each section's text under Slack's
// hard limit. Teams/Discord must not throw on the same large payload.

const SLACK_SECTION_TEXT_LIMIT = 3000; // Slack Block Kit section text max
const SLACK_LIST_CAP = 10;

// Recursively collect every Block Kit section's mrkdwn text so we can assert
// the per-section limit (Slack enforces it per block, not on the whole payload).
function slackSectionTexts(out: unknown): string[] {
  const blocks = (out as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === "section" && b.text && typeof b.text === "object") {
      const t = (b.text as { text?: unknown }).text;
      if (typeof t === "string") texts.push(t);
    }
  }
  return texts;
}

test("slack: flaky.detected with 30 flaky tests caps the list at 10 + overflow", () => {
  const flaky_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Suite > flaky case ${i}`,
    file_path: `spec_${i}.cy.ts`,
    flaky_rate: 25 + i,
    flip_count: i,
    fail_count: i % 5,
    total_runs: 100,
  }));
  const out = formatPayload("slack", basePayload({ event: "flaky.detected", flaky_tests }));
  JSON.parse(JSON.stringify(out)); // serializable

  const texts = slackSectionTexts(out);
  // Find the section that lists the flaky rows (the one containing rate lines).
  const listSection = texts.find((t) => t.includes("% flaky"));
  assert.ok(listSection, "expected a section rendering the flaky list");

  // Exactly the first 10 rows are rendered; the 11th and beyond are not.
  assert.ok(listSection.includes("flaky case 0"), "first row missing");
  assert.ok(listSection.includes("flaky case 9"), "10th row missing");
  assert.ok(!listSection.includes("flaky case 10"), "11th row should be capped out");
  assert.ok(!listSection.includes("flaky case 29"), "last row should be capped out");

  // Overflow indicator names the remaining count.
  assert.ok(
    listSection.includes(`…and ${30 - SLACK_LIST_CAP} more`),
    `expected overflow indicator for the ${30 - SLACK_LIST_CAP} hidden rows`,
  );
});

test("slack: new.failures shows new-failure section AND all-failures heading, ordered correctly", () => {
  // Many regressions plus a larger total failed set.
  const new_failures = Array.from({ length: 12 }, (_, i) => ({
    full_title: `Regressed ${i}`,
    error_message: `boom ${i}`,
    spec_file: `reg_${i}.cy.ts`,
  }));
  const failed_tests = Array.from({ length: 25 }, (_, i) => ({
    full_title: `Failure ${i}`,
    error_message: null,
    spec_file: `fail_${i}.cy.ts`,
  }));
  const out = formatPayload("slack", basePayload({ event: "new.failures", new_failures, failed_tests }));
  JSON.parse(JSON.stringify(out));

  const texts = slackSectionTexts(out);
  const blob = texts.join("\n");

  // Both sections present: the "N New Failures" heading and the "All N failures:" heading.
  const newHeadingIdx = blob.indexOf(`${new_failures.length} New Failure`);
  const allHeadingIdx = blob.indexOf(`All ${failed_tests.length} failures:`);
  assert.ok(newHeadingIdx >= 0, "new-failures heading missing");
  assert.ok(allHeadingIdx >= 0, "all-failures heading missing");
  // Ordering: new failures appear before the all-failures heading.
  assert.ok(newHeadingIdx < allHeadingIdx, "new failures must be rendered before the all-failures heading");

  // The new-failures list section is capped at 10 + overflow.
  const newListSection = texts.find((t) => t.includes("Regressed 0"));
  assert.ok(newListSection, "new-failures list section missing");
  assert.ok(newListSection.includes("Regressed 9"), "10th new failure missing");
  assert.ok(!newListSection.includes("Regressed 10"), "11th new failure should be capped");
  assert.ok(newListSection.includes(`…and ${12 - SLACK_LIST_CAP} more`), "new-failures overflow indicator missing");
});

test("slack: every section text stays within Slack's 3000-char limit on a large payload", () => {
  // 30 flaky rows, each with a deliberately long title, would blow past
  // 3000 chars if joined verbatim. The formatter must keep each section
  // under the limit.
  const longTitle = "y".repeat(400);
  const flaky_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `${longTitle} ${i}`,
    file_path: `${"z".repeat(200)}_${i}.cy.ts`,
    flaky_rate: 50,
    flip_count: i,
    fail_count: 1,
    total_runs: 10,
  }));
  const out = formatPayload("slack", basePayload({ event: "flaky.detected", flaky_tests }));
  JSON.parse(JSON.stringify(out));

  for (const text of slackSectionTexts(out)) {
    assert.ok(
      text.length <= SLACK_SECTION_TEXT_LIMIT,
      `section text length ${text.length} exceeds Slack's ${SLACK_SECTION_TEXT_LIMIT}-char limit`,
    );
  }
});

test("teams and discord do not throw on the same large flaky payload", () => {
  const flaky_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Suite > flaky case ${"q".repeat(200)} ${i}`,
    file_path: `spec_${i}.cy.ts`,
    flaky_rate: 30,
    flip_count: i,
    fail_count: 2,
    total_runs: 10,
  }));
  const payload = basePayload({ event: "flaky.detected", flaky_tests });

  for (const platform of ["teams", "discord"] as const) {
    const out = formatPayload(platform, payload);
    const json = JSON.stringify(out); // must be serializable
    JSON.parse(json);
    assert.ok(out, `${platform}: returned nullish on large payload`);
  }

  // Discord caps its embed description at 4000 chars — verify it never exceeds that.
  const discordOut = formatPayload("discord", payload) as { embeds?: Array<{ description?: string }> };
  const desc = discordOut.embeds?.[0]?.description ?? "";
  assert.ok(desc.length <= 4000, `discord description length ${desc.length} exceeds the 4000-char cap`);
});

// ── Unknown platform falls through to generic ────────────────────────────

test("formatPayload: unknown platform falls through to generic format", () => {
  const out = formatPayload("not-a-real-platform", basePayload()) as { text?: string };
  assert.ok(out.text, "unknown platform should produce the generic shape with a text field");
});

test("formatPayload: empty platform string falls through to generic format", () => {
  const out = formatPayload("", basePayload()) as { text?: string };
  assert.ok(out.text);
});
