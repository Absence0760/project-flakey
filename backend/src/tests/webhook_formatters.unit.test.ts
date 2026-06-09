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

// ── flaky.threshold.exceeded event variant ───────────────────────────────
//
// Feature A: when a test's flaky_rate crosses the org's configured
// flaky_alert_threshold, webhooks.ts dispatches a flaky.threshold.exceeded
// event carrying the same flaky_tests payload as flaky.detected — only the
// heading/title differs. Mirror the flaky.detected coverage: every platform
// must produce serializable output, surface a sensible title, and render the
// flaky rows.

// Pull a flat list of every string the formatter emitted (titles, headings,
// row text) so we can assert content regardless of where each platform puts it.
function collectStrings(out: unknown): string[] {
  const acc: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") acc.push(v);
    // The generic format passes flaky_tests through as objects with numeric
    // fields (flaky_rate etc.) rather than baking them into a text string;
    // capture numbers too so "the rate is present" holds across platforms.
    else if (typeof v === "number") acc.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(out);
  return acc;
}

for (const platform of PLATFORMS) {
  test(`${platform}: flaky.threshold.exceeded event with flaky_tests array`, () => {
    const out = formatPayload(platform, basePayload({
      event: "flaky.threshold.exceeded",
      flaky_tests: [
        { full_title: "API > flaky over threshold", file_path: "api.cy.ts",
          flaky_rate: 62, flip_count: 6, fail_count: 6, total_runs: 10 },
      ],
    }));
    const json = JSON.stringify(out);
    assert.ok(json.length > 0, `${platform}: produced empty output`);
    JSON.parse(json); // serializable round-trip

    const strings = collectStrings(out);
    const blob = strings.join("\n");
    // Sensible title that names the threshold-exceeded condition (not the
    // generic "failed" or the flaky.detected heading).
    assert.match(
      blob,
      /threshold/i,
      `${platform}: threshold event must carry a title naming the threshold condition`,
    );
    // The flaky test row is rendered (title + rate).
    assert.ok(blob.includes("API > flaky over threshold"), `${platform}: flaky test title missing`);
    assert.ok(blob.includes("62"), `${platform}: flaky_rate not rendered`);
  });

  test(`${platform}: flaky.threshold.exceeded without flaky_tests array does not crash`, () => {
    const out = formatPayload(platform, basePayload({
      event: "flaky.threshold.exceeded",
      flaky_tests: undefined,
    }));
    JSON.stringify(out);
    assert.ok(out);
  });
}

// flaky.detected output must be UNCHANGED by the threshold addition — the two
// events share the flaky_tests payload but their headings/titles must differ
// and flaky.detected must keep its own wording.
test("flaky.detected output is unchanged and distinct from flaky.threshold.exceeded", () => {
  const flaky_tests = [
    { full_title: "API > should return 200", file_path: "api.cy.ts",
      flaky_rate: 30, flip_count: 4, fail_count: 3, total_runs: 10 },
  ];
  for (const platform of PLATFORMS) {
    const detected = collectStrings(formatPayload(platform, basePayload({ event: "flaky.detected", flaky_tests }))).join("\n");
    const threshold = collectStrings(formatPayload(platform, basePayload({ event: "flaky.threshold.exceeded", flaky_tests }))).join("\n");

    // flaky.detected keeps its "flaky"/"detected" wording (generic uses
    // "flaky test(s) detected"; the rich platforms use "Flaky Tests Detected").
    assert.match(detected, /flaky/i, `${platform}: flaky.detected lost its 'flaky' wording`);
    assert.match(detected, /detect/i, `${platform}: flaky.detected lost its 'detected' wording`);
    // The two events must not produce byte-identical output — the heading differs.
    assert.notEqual(detected, threshold, `${platform}: the two flaky events must render distinct headings`);
    // And flaky.detected must NOT advertise the threshold condition.
    assert.ok(!/threshold/i.test(detected), `${platform}: flaky.detected must not mention 'threshold'`);
  }
});

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

// ── Platform payload-validity regressions ────────────────────────────────
//
// Each formatter must keep its output within the receiving platform's hard
// limits and actually render the content it promises. These pin four bugs:
//   #1 Slack new.failures emitted an "All N failures:" heading with no list.
//   #2 Slack header could exceed Slack's 150-char plain_text limit.
//   #3 Teams rendered one TextBlock per row with no cap (oversized card).
//   #4 Discord embed title could exceed Discord's 256-char limit.

const SLACK_HEADER_TEXT_LIMIT = 150;
const SLACK_FIELD_TEXT_LIMIT = 2000;
const TEAMS_LIST_CAP = 20;
const TEAMS_TEXT_LIMIT = 256;
const DISCORD_TITLE_LIMIT = 256;
const DISCORD_LIST_CAP = 20; // mirrors webhook-formatters.ts

function discordDescriptionLines(out: unknown): string[] {
  const desc = (out as { embeds?: Array<{ description?: string }> }).embeds?.[0]?.description ?? "";
  return desc.split("\n");
}

function slackHeaderText(out: unknown): string | undefined {
  const blocks = (out as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
  const header = blocks.find((b) => b.type === "header");
  const text = (header?.text as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

function teamsTextBlocks(out: unknown): string[] {
  const content = (out as { attachments?: Array<{ content?: { body?: Array<Record<string, unknown>> } }> })
    .attachments?.[0]?.content;
  const body = content?.body ?? [];
  return body
    .filter((b) => b.type === "TextBlock" && typeof b.text === "string")
    .map((b) => b.text as string);
}

// #1 — the all-failures list body, not just the heading.
test("slack: new.failures renders the all-failures list body beneath its heading", () => {
  const new_failures = [
    { full_title: "Regressed A", error_message: "boom", spec_file: "reg.cy.ts" },
  ];
  const failed_tests = Array.from({ length: 25 }, (_, i) => ({
    full_title: `Failure ${i}`,
    error_message: null,
    spec_file: `fail_${i}.cy.ts`,
  }));
  const out = formatPayload("slack", basePayload({ event: "new.failures", new_failures, failed_tests }));
  const texts = slackSectionTexts(out);

  assert.ok(
    texts.some((t) => t.includes(`All ${failed_tests.length} failures:`)),
    "all-failures heading missing",
  );
  // The actual rows must render under the heading — the bug emitted the heading
  // with nothing beneath it.
  const body = texts.find((t) => t.includes("Failure 0"));
  assert.ok(body, "all-failures list body missing — the heading had no list beneath it");
  assert.ok(body!.includes("Failure 9"), "10th failure row missing");
  assert.ok(!body!.includes("Failure 10"), "11th failure row should be capped out");
  assert.ok(body!.includes(`…and ${25 - 10} more`), "all-failures overflow indicator missing");
});

// #2 — Slack header within the 150-char limit.
test("slack: a very long suite name keeps the header within Slack's 150-char limit", () => {
  const out = formatPayload("slack", basePayload({
    run: { ...basePayload().run, suite_name: "s".repeat(400) },
  }));
  const header = slackHeaderText(out);
  assert.ok(header, "slack header text missing");
  assert.ok(
    header!.length <= SLACK_HEADER_TEXT_LIMIT,
    `slack header length ${header!.length} exceeds Slack's ${SLACK_HEADER_TEXT_LIMIT}-char limit`,
  );
});

// #2b — Slack section fields: the unbounded branch value stays within 2000.
test("slack: an oversized branch keeps the branch field within Slack's 2000-char field limit", () => {
  const out = formatPayload("slack", basePayload({
    run: { ...basePayload().run, branch: "b".repeat(5000) },
  }));
  const blocks = (out as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
  const fieldsBlock = blocks.find(
    (b) => b.type === "section" && Array.isArray((b as { fields?: unknown }).fields),
  );
  const fields = ((fieldsBlock as { fields?: Array<{ text: string }> })?.fields) ?? [];
  const branch = fields.find((f) => f.text.startsWith("*Branch:*"));
  assert.ok(branch, "branch field missing");
  assert.ok(
    branch!.text.length <= SLACK_FIELD_TEXT_LIMIT,
    `slack branch field length ${branch!.text.length} exceeds Slack's ${SLACK_FIELD_TEXT_LIMIT}-char field limit`,
  );
});

// #3b — Teams title + FactSet values stay within the Teams text bound.
test("teams: oversized title and fact values stay within the Teams text bound", () => {
  const out = formatPayload("teams", basePayload({
    run: { ...basePayload().run, suite_name: "s".repeat(5000), branch: "b".repeat(5000) },
    trend: "t".repeat(5000),
  }));
  const content = (out as { attachments?: Array<{ content?: { body?: Array<Record<string, unknown>> } }> })
    .attachments?.[0]?.content;
  const body = content?.body ?? [];

  const title = body.find((b) => b.type === "TextBlock" && b.size === "Large") as { text?: string } | undefined;
  assert.ok(title?.text, "teams title block missing");
  assert.ok(
    title!.text!.length <= TEAMS_TEXT_LIMIT,
    `teams title length ${title!.text!.length} exceeds the ${TEAMS_TEXT_LIMIT}-char bound`,
  );

  const factSet = body.find((b) => b.type === "FactSet") as { facts?: Array<{ title: string; value: string }> } | undefined;
  assert.ok(factSet?.facts, "teams FactSet missing");
  for (const f of factSet!.facts!) {
    assert.ok(
      f.value.length <= TEAMS_TEXT_LIMIT,
      `teams fact "${f.title}" value length ${f.value.length} exceeds the ${TEAMS_TEXT_LIMIT}-char bound`,
    );
  }
});

// #3 — Teams caps each list with an overflow row.
test("teams: caps failed-test rows at the list cap with an overflow row", () => {
  const failed_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Failure ${i}`,
    error_message: null,
    spec_file: `f_${i}.cy.ts`,
  }));
  const out = formatPayload("teams", basePayload({ failed_tests }));
  const blocks = teamsTextBlocks(out);

  // Rows start with the bullet; headings/title TextBlocks do not.
  const rows = blocks.filter((t) => t.startsWith("•"));
  assert.ok(rows.length <= TEAMS_LIST_CAP, `teams rendered ${rows.length} rows, expected <= ${TEAMS_LIST_CAP}`);
  assert.ok(!blocks.some((t) => t.includes("Failure 29")), "row beyond the cap should not render");
  assert.ok(
    blocks.some((t) => t.includes(`…and ${30 - TEAMS_LIST_CAP} more`)),
    "teams overflow indicator missing",
  );
});

test("teams: caps flaky rows at the list cap with an overflow row", () => {
  const flaky_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Flaky ${i}`,
    file_path: `f_${i}.cy.ts`,
    flaky_rate: 30,
    flip_count: i,
    fail_count: 1,
    total_runs: 10,
  }));
  const out = formatPayload("teams", basePayload({ event: "flaky.detected", flaky_tests }));
  const blocks = teamsTextBlocks(out);

  const rows = blocks.filter((t) => t.startsWith("•"));
  assert.ok(rows.length <= TEAMS_LIST_CAP, `teams rendered ${rows.length} flaky rows, expected <= ${TEAMS_LIST_CAP}`);
  assert.ok(
    blocks.some((t) => t.includes(`…and ${30 - TEAMS_LIST_CAP} more`)),
    "teams flaky overflow indicator missing",
  );
});

test("discord: caps flaky rows at the list cap with an overflow row (not a mid-line truncation)", () => {
  // Regression: Discord built its description from the FULL flaky list and then
  // hard-truncated to 4000 chars — cutting mid-line, dropping the tail with no
  // indication, while the header still claimed the full count. Slack/Teams cap
  // with an "…and N more" row; Discord must too.
  const flaky_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Flaky ${i}`,
    file_path: `f_${i}.cy.ts`,
    flaky_rate: 30,
    flip_count: i,
    fail_count: 1,
    total_runs: 10,
  }));
  const lines = discordDescriptionLines(formatPayload("discord", basePayload({ event: "flaky.detected", flaky_tests })));

  const rows = lines.filter((l) => l.includes("🎲"));
  assert.ok(rows.length <= DISCORD_LIST_CAP, `discord rendered ${rows.length} flaky rows, expected <= ${DISCORD_LIST_CAP}`);
  assert.ok(!lines.some((l) => l.includes("Flaky 29")), "a flaky row beyond the cap must not render");
  assert.ok(
    lines.some((l) => l.includes(`…and ${30 - DISCORD_LIST_CAP} more`)),
    "discord flaky overflow indicator missing",
  );
});

test("discord: caps failed-test rows at the list cap with an overflow row", () => {
  const failed_tests = Array.from({ length: 30 }, (_, i) => ({
    full_title: `Failure ${i}`,
    error_message: null,
    spec_file: `f_${i}.cy.ts`,
  }));
  const lines = discordDescriptionLines(formatPayload("discord", basePayload({ failed_tests })));

  const rows = lines.filter((l) => l.startsWith("•"));
  assert.ok(rows.length <= DISCORD_LIST_CAP, `discord rendered ${rows.length} failure rows, expected <= ${DISCORD_LIST_CAP}`);
  assert.ok(!lines.some((l) => l.includes("Failure 29")), "a failure row beyond the cap must not render");
  assert.ok(
    lines.some((l) => l.includes(`…and ${30 - DISCORD_LIST_CAP} more`)),
    "discord failure overflow indicator missing",
  );
});

// #1 edge — when every failure is new, no supplemental all-failures section.
test("slack: new.failures with no extra failures emits neither the all-failures heading nor a body", () => {
  const tests = Array.from({ length: 3 }, (_, i) => ({
    full_title: `Regressed ${i}`,
    error_message: `boom ${i}`,
    spec_file: `reg_${i}.cy.ts`,
  }));
  // failed_tests === new_failures: all failures are new, nothing extra to list.
  const out = formatPayload("slack", basePayload({ event: "new.failures", new_failures: tests, failed_tests: tests }));
  const texts = slackSectionTexts(out);
  assert.ok(
    !texts.some((t) => t.includes("All 3 failures:")),
    "all-failures heading must be suppressed when there are no failures beyond the new ones",
  );
});

// #4 — Discord embed title within the 256-char limit.
test("discord: a very long suite name keeps the embed title within Discord's 256-char limit", () => {
  const out = formatPayload("discord", basePayload({
    run: { ...basePayload().run, suite_name: "s".repeat(400) },
  })) as { embeds?: Array<{ title?: string }> };
  const title = out.embeds?.[0]?.title ?? "";
  assert.ok(title.length > 0, "discord embed title missing");
  assert.ok(
    title.length <= DISCORD_TITLE_LIMIT,
    `discord title length ${title.length} exceeds Discord's ${DISCORD_TITLE_LIMIT}-char limit`,
  );
});

// #4b — Discord embed field values stay within the 1–1024-char bound.
const DISCORD_FIELD_VALUE_LIMIT = 1024;
test("discord: empty and oversized suite/branch field values are bounded to Discord's 1-1024 limit", () => {
  type Field = { name: string; value: string };
  const longOut = formatPayload("discord", basePayload({
    run: { ...basePayload().run, suite_name: "s".repeat(2000) },
    trend: "t".repeat(2000),
  })) as { embeds?: Array<{ fields?: Field[] }> };
  for (const f of longOut.embeds?.[0]?.fields ?? []) {
    assert.ok(
      f.value.length >= 1 && f.value.length <= DISCORD_FIELD_VALUE_LIMIT,
      `discord field "${f.name}" value length ${f.value.length} is outside Discord's 1-${DISCORD_FIELD_VALUE_LIMIT} bound`,
    );
  }

  // An empty suite/branch must fall back to a non-empty value (Discord rejects "").
  const emptyOut = formatPayload("discord", basePayload({
    run: { ...basePayload().run, suite_name: "", branch: "" },
  })) as { embeds?: Array<{ fields?: Field[] }> };
  const fields = emptyOut.embeds?.[0]?.fields ?? [];
  const suite = fields.find((f) => f.name === "Suite");
  const branch = fields.find((f) => f.name === "Branch");
  assert.ok((suite?.value.length ?? 0) >= 1, "empty suite_name must fall back to a non-empty field value");
  assert.ok((branch?.value.length ?? 0) >= 1, "empty branch must fall back to a non-empty field value");
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
