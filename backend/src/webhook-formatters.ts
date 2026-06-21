export interface WebhookRunPayload {
  event: string;
  run: {
    id: number;
    suite_name: string;
    branch: string;
    commit_sha: string;
    duration_ms: number;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    url: string;
  };
  failed_tests: Array<{
    full_title: string;
    error_message: string | null;
    spec_file: string;
  }>;
  new_failures?: Array<{
    full_title: string;
    error_message: string | null;
    spec_file: string;
  }>;
  flaky_tests?: Array<{
    full_title: string;
    file_path: string;
    flaky_rate: number;
    flip_count: number;
    fail_count: number;
    total_runs: number;
  }>;
  // Phase 15.2 — carried by the error-group lifecycle events (error.regressed,
  // error.autoclosed). Identifies the triage unit (fingerprint) and its new
  // state. Absent on run-centric events.
  error_group?: {
    fingerprint: string;
    suite_name: string;
    status: string;
    error_message: string | null;
    recurrence_count?: number;
    url: string;
  };
  trend: string;
}

// Keep backward compat
export type WebhookRunFailedPayload = WebhookRunPayload;

export function formatPayload(platform: string, payload: WebhookRunFailedPayload): object {
  switch (platform) {
    case "slack": return formatSlack(payload);
    case "teams": return formatTeams(payload);
    case "discord": return formatDiscord(payload);
    default: return formatGeneric(payload);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "\u2026" : str;
}

// Slack rejects a section block whose text exceeds 3000 chars, and a
// section with too many lines makes for an unusable message. Cap how many
// test rows we render per list, then guard the joined text against Slack's
// hard limit so the payload always stays valid.
const SLACK_LIST_CAP = 10;
const SLACK_SECTION_TEXT_LIMIT = 3000;
// Slack section `fields` each take an mrkdwn text capped at 2000 chars. Only the
// branch field carries an unbounded value, so guard its assembled text.
const SLACK_FIELD_TEXT_LIMIT = 2000;
// Slack `header` blocks take a plain_text whose text maxes out at 150 chars;
// past that Slack rejects the whole message with invalid_blocks. The title
// embeds the (unbounded) suite name, so it must be truncated.
const SLACK_HEADER_TEXT_LIMIT = 150;
// Teams renders one TextBlock per test row; an Adaptive Card has a hard ~28KB
// size limit, so an unbounded list silently drops the whole notification on a
// big run. Cap rows (Slack/Discord already bound their output) with an overflow
// line, matching the Slack list behaviour.
const TEAMS_LIST_CAP = 20;
// Teams has no per-element char limit, but the title + FactSet values embed
// unbounded user strings (suite name, branch, trend) that count toward the
// card's ~28KB ceiling. Bound them generously — past any legitimate value.
const TEAMS_TEXT_LIMIT = 256;
// Discord embed titles max out at 256 chars; past that the embed is rejected.
const DISCORD_TITLE_LIMIT = 256;
// Discord embed field values must be 1–1024 chars; empty or oversized → reject.
const DISCORD_FIELD_VALUE_LIMIT = 1024;
// Cap how many list rows a Discord embed renders, like Slack/Teams. Without
// this the description was built from the FULL list and then hard-truncated to
// 4000 chars (see below) — cutting mid-line with no indication, while the
// header still claimed the full count. Cap + an "…and N more" row instead.
const DISCORD_LIST_CAP = 20;
function discordOverflow(total: number): string | null {
  return total > DISCORD_LIST_CAP ? `…and ${total - DISCORD_LIST_CAP} more` : null;
}

// The "…and N more" overflow row Teams appends when a list is capped.
function teamsOverflow(total: number): object | null {
  if (total <= TEAMS_LIST_CAP) return null;
  return {
    type: "TextBlock",
    text: `\u2026and ${total - TEAMS_LIST_CAP} more`,
    wrap: true,
    size: "Small",
    isSubtle: true,
  };
}

function slackSectionText(lines: string[], total: number): string {
  const shown = lines.slice(0, SLACK_LIST_CAP);
  if (total > SLACK_LIST_CAP) {
    shown.push(`\u2026and ${total - SLACK_LIST_CAP} more`);
  }
  const text = shown.join("\n");
  return text.length > SLACK_SECTION_TEXT_LIMIT
    ? text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1) + "\u2026"
    : text;
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "n/a";
}

// --- Generic (backward-compatible) ---

function formatGeneric(p: WebhookRunFailedPayload): object {
  const text = p.event === "flaky.threshold.exceeded"
    ? `Run #${p.run.id}: ${p.flaky_tests?.length ?? 0} test(s) exceeded the flaky-rate threshold in '${p.run.suite_name}'`
    : p.event === "flaky.detected"
    ? `Run #${p.run.id}: ${p.flaky_tests?.length ?? 0} flaky test(s) detected in '${p.run.suite_name}'`
    : p.event === "error.regressed"
    ? `Regression: a previously-fixed failure reappeared in '${p.run.suite_name}'`
    : p.event === "error.autoclosed"
    ? `Auto-closed: a failure went green for the configured window in '${p.run.suite_name}'`
    : `Run #${p.run.id} failed: ${p.run.failed}/${p.run.total} tests failed in suite '${p.run.suite_name}'`;
  return {
    text,
    event: p.event,
    run: p.run,
    failed_tests: p.failed_tests,
    ...(p.flaky_tests ? { flaky_tests: p.flaky_tests } : {}),
    ...(p.error_group ? { error_group: p.error_group } : {}),
    trend: p.trend,
  };
}

// --- Slack Block Kit ---

function headerForEvent(p: WebhookRunPayload): { emoji: string; title: string } {
  const { run } = p;
  switch (p.event) {
    case "run.passed":
      return { emoji: "\u2705", title: `\u2705 Run #${run.id} Passed \u2014 ${run.suite_name}` };
    case "new.failures":
      return { emoji: "\ud83d\udea8", title: `\ud83d\udea8 New Failures in Run #${run.id} \u2014 ${run.suite_name}` };
    case "flaky.detected":
      return { emoji: "\ud83c\udfb2", title: `\ud83c\udfb2 Flaky Tests Detected \u2014 Run #${run.id} ${run.suite_name}` };
    case "flaky.threshold.exceeded":
      return { emoji: "\u26a0\ufe0f", title: `\u26a0\ufe0f Flaky Rate Threshold Exceeded \u2014 Run #${run.id} ${run.suite_name}` };
    case "error.regressed":
      return { emoji: "\ud83d\udd01", title: `\ud83d\udd01 Regression \u2014 a fixed failure came back in ${run.suite_name}` };
    case "error.autoclosed":
      return { emoji: "\u2705", title: `\u2705 Auto-closed \u2014 a failure went green in ${run.suite_name}` };
    case "run.completed":
      return run.failed > 0
        ? { emoji: "\u274c", title: `\u274c Run #${run.id} Completed \u2014 ${run.suite_name}` }
        : { emoji: "\u2705", title: `\u2705 Run #${run.id} Completed \u2014 ${run.suite_name}` };
    default:
      return { emoji: "\u274c", title: `\u274c Run #${run.id} Failed \u2014 ${run.suite_name}` };
  }
}

function formatSlack(p: WebhookRunPayload): object {
  const { run } = p;
  const { title } = headerForEvent(p);

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(title, SLACK_HEADER_TEXT_LIMIT), emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: truncate(`*Branch:*\n${run.branch || "n/a"}`, SLACK_FIELD_TEXT_LIMIT) },
        { type: "mrkdwn", text: `*Commit:*\n\`${shortSha(run.commit_sha)}\`` },
        { type: "mrkdwn", text: `*Duration:*\n${formatDuration(run.duration_ms)}` },
        { type: "mrkdwn", text: `*Results:*\n\u274c ${run.failed} failed  \u2705 ${run.passed} passed  \u23e9 ${run.skipped} skipped` },
      ],
    },
  ];

  if (p.trend) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Recent:* ${p.trend}` }],
    });
  }

  // Show new failures prominently if this is a new.failures event
  if (p.event === "new.failures" && p.new_failures && p.new_failures.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*\ud83d\udea8 ${p.new_failures.length} New Failure${p.new_failures.length > 1 ? "s" : ""} (passed last run, failing now):*` },
    });
    // Only the first SLACK_LIST_CAP rows are ever rendered; map just those
    // (slackSectionText derives the overflow count from the full length).
    const lines = p.new_failures.slice(0, SLACK_LIST_CAP).map((t) => {
      const err = t.error_message ? `\n> ${truncate(t.error_message, 150)}` : "";
      return `\u2022 \`${truncate(t.spec_file, 40)}\` \u2014 *${truncate(t.full_title, 80)}*${err}`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: slackSectionText(lines, p.new_failures.length) },
    });
  }

  // Flaky tests section \u2014 shared by flaky.detected and flaky.threshold.exceeded
  // (both carry the same flaky_tests payload; only the heading differs).
  if ((p.event === "flaky.detected" || p.event === "flaky.threshold.exceeded") && p.flaky_tests && p.flaky_tests.length > 0) {
    const flakyHeading = p.event === "flaky.threshold.exceeded"
      ? `*\u26a0\ufe0f ${p.flaky_tests.length} Test${p.flaky_tests.length > 1 ? "s" : ""} Over Flaky-Rate Threshold:*`
      : `*\ud83c\udfb2 ${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:*`;
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: flakyHeading },
    });
    const lines = p.flaky_tests.slice(0, SLACK_LIST_CAP).map((t) =>
      `\u2022 *${truncate(t.full_title, 80)}*\n>  \`${truncate(t.file_path, 40)}\` \u2014 ${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`
    );
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: slackSectionText(lines, p.flaky_tests.length) },
    });
  }

  // Error-group lifecycle events (regressed / autoclosed) — render the triage
  // unit, not a run failure list.
  if ((p.event === "error.regressed" || p.event === "error.autoclosed") && p.error_group) {
    const eg = p.error_group;
    const heading = p.event === "error.regressed"
      ? `*\ud83d\udd01 A previously-fixed failure reappeared*`
      : `*\u2705 A failure went green and was auto-closed*`;
    const lines = [
      `${truncate(eg.error_message ?? "(no message)", 200)}`,
      `\`${truncate(eg.suite_name, 60)}\` — now *${eg.status}*`
        + (eg.recurrence_count ? ` (recurred ${eg.recurrence_count}×)` : ""),
    ];
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: heading } });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(lines.join("\n"), SLACK_SECTION_TEXT_LIMIT) } });
  }

  if (p.failed_tests.length > 0 && p.event !== "run.passed" && p.event !== "flaky.detected" && p.event !== "flaky.threshold.exceeded") {
    const failureLines = p.failed_tests.slice(0, SLACK_LIST_CAP).map((t) => {
      const err = t.error_message ? `\n> ${truncate(t.error_message, 150)}` : "";
      return `\u2022 \`${truncate(t.spec_file, 40)}\` \u2014 *${truncate(t.full_title, 80)}*${err}`;
    });
    if (p.event === "new.failures") {
      // The new failures are already rendered above. Only add the full list
      // when it holds more than just those \u2014 and render the rows under the
      // heading, not just the heading (the heading used to be emitted with no
      // body, leaving a dangling "All N failures:" with nothing beneath it).
      if (p.failed_tests.length > (p.new_failures?.length ?? 0)) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*All ${p.failed_tests.length} failures:*` },
        });
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: slackSectionText(failureLines, p.failed_tests.length) },
        });
      }
    } else {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: slackSectionText(failureLines, p.failed_tests.length) },
      });
    }
  }

  // Error-group events deep-link to the triage unit; run events to the run.
  const actionUrl = p.error_group?.url ?? run.url;
  const actionLabel = p.error_group ? "View Error Group" : "View Run";
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: actionLabel }, url: actionUrl },
    ],
  });

  const fallback = p.event === "run.passed"
    ? `Run #${run.id} passed: ${run.passed}/${run.total} tests in '${run.suite_name}'`
    : p.event === "new.failures"
    ? `Run #${run.id}: ${p.new_failures?.length ?? 0} new failure(s) in '${run.suite_name}'`
    : p.event === "flaky.threshold.exceeded"
    ? `Run #${run.id}: ${p.flaky_tests?.length ?? 0} test(s) over the flaky-rate threshold in '${run.suite_name}'`
    : p.event === "flaky.detected"
    ? `Run #${run.id}: ${p.flaky_tests?.length ?? 0} flaky test(s) in '${run.suite_name}'`
    : p.event === "error.regressed"
    ? `Regression: a previously-fixed failure reappeared in '${run.suite_name}'`
    : p.event === "error.autoclosed"
    ? `Auto-closed: a failure went green in '${run.suite_name}'`
    : `Run #${run.id} failed: ${run.failed}/${run.total} tests failed in '${run.suite_name}'`;

  return { text: fallback, blocks };
}

// --- Microsoft Teams Adaptive Card ---

function formatTeams(p: WebhookRunPayload): object {
  const { run } = p;
  const { title } = headerForEvent(p);
  const color = (p.event === "run.passed") ? "Good" : "Attention";
  const body: object[] = [
    {
      type: "TextBlock",
      size: "Large",
      weight: "Bolder",
      color,
      text: truncate(title, TEAMS_TEXT_LIMIT),
    },
    {
      type: "FactSet",
      facts: [
        { title: "Branch", value: truncate(run.branch || "n/a", TEAMS_TEXT_LIMIT) },
        { title: "Commit", value: shortSha(run.commit_sha) },
        { title: "Duration", value: formatDuration(run.duration_ms) },
        { title: "Results", value: `${run.failed} failed / ${run.passed} passed / ${run.skipped} skipped` },
        { title: "Recent", value: truncate(p.trend || "n/a", TEAMS_TEXT_LIMIT) },
      ],
    },
  ];

  if (p.event === "new.failures" && p.new_failures && p.new_failures.length > 0) {
    body.push({
      type: "TextBlock",
      text: `**\ud83d\udea8 ${p.new_failures.length} New Failure${p.new_failures.length > 1 ? "s" : ""}** (passed last run):`,
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const t of p.new_failures.slice(0, TEAMS_LIST_CAP)) {
      const err = t.error_message ? `\n\n${truncate(t.error_message, 150)}` : "";
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.spec_file, 40)}\`${err}`,
        wrap: true,
        size: "Small",
      });
    }
    const more = teamsOverflow(p.new_failures.length);
    if (more) body.push(more);
  }

  if ((p.event === "flaky.detected" || p.event === "flaky.threshold.exceeded") && p.flaky_tests && p.flaky_tests.length > 0) {
    body.push({
      type: "TextBlock",
      text: p.event === "flaky.threshold.exceeded"
        ? `**\u26a0\ufe0f ${p.flaky_tests.length} Test${p.flaky_tests.length > 1 ? "s" : ""} Over Flaky-Rate Threshold:**`
        : `**\ud83c\udfb2 ${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:**`,
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const t of p.flaky_tests.slice(0, TEAMS_LIST_CAP)) {
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.file_path, 40)}\`\n\n${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`,
        wrap: true,
        size: "Small",
      });
    }
    const more = teamsOverflow(p.flaky_tests.length);
    if (more) body.push(more);
  }

  if ((p.event === "error.regressed" || p.event === "error.autoclosed") && p.error_group) {
    const eg = p.error_group;
    body.push({
      type: "TextBlock",
      text: p.event === "error.regressed"
        ? "**\ud83d\udd01 A previously-fixed failure reappeared**"
        : "**\u2705 A failure went green and was auto-closed**",
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "TextBlock",
      text: `${truncate(eg.error_message ?? "(no message)", 200)}\n\n\`${truncate(eg.suite_name, 60)}\` — now **${eg.status}**`
        + (eg.recurrence_count ? ` (recurred ${eg.recurrence_count}×)` : ""),
      wrap: true,
      size: "Small",
    });
  }

  if (p.failed_tests.length > 0 && p.event !== "run.passed" && p.event !== "flaky.detected" && p.event !== "flaky.threshold.exceeded") {
    body.push({
      type: "TextBlock",
      text: p.event === "new.failures" ? "**All Failures:**" : "**Failed Tests**",
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const t of p.failed_tests.slice(0, TEAMS_LIST_CAP)) {
      const err = t.error_message ? `\n\n${truncate(t.error_message, 150)}` : "";
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.spec_file, 40)}\`${err}`,
        wrap: true,
        size: "Small",
      });
    }
    const more = teamsOverflow(p.failed_tests.length);
    if (more) body.push(more);
  }

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        fallbackText: `${title}`,
        body,
        actions: [
          {
            type: "Action.OpenUrl",
            title: p.error_group ? "View Error Group" : "View Run",
            url: p.error_group?.url ?? run.url,
          },
        ],
      },
    }],
  };
}

// --- Discord Embed ---

function formatDiscord(p: WebhookRunPayload): object {
  const { run } = p;
  const { title } = headerForEvent(p);
  const embedColor = p.event === "run.passed" ? 0x22863a
    : p.event === "error.autoclosed" ? 0x22863a
    : p.event === "flaky.detected" ? 0xf59e0b
    : p.event === "flaky.threshold.exceeded" ? 0xf59e0b
    : p.event === "error.regressed" ? 0xff8800
    : p.event === "new.failures" ? 0xff8800
    : 0xff4444;

  // Discord rejects an embed whose field value is empty or exceeds 1024 chars,
  // so the user-derived values (suite, branch, trend) get a fallback + cap.
  const fields = [
    { name: "Suite", value: truncate(run.suite_name || "n/a", DISCORD_FIELD_VALUE_LIMIT), inline: true },
    { name: "Branch", value: truncate(run.branch || "n/a", DISCORD_FIELD_VALUE_LIMIT), inline: true },
    { name: "Commit", value: `\`${shortSha(run.commit_sha)}\``, inline: true },
    { name: "Results", value: `\u274c ${run.failed} failed \u2002\u2705 ${run.passed} passed \u2002\u23e9 ${run.skipped} skipped`, inline: false },
    { name: "Duration", value: formatDuration(run.duration_ms), inline: true },
  ];

  if (p.trend) {
    fields.push({ name: "Recent", value: truncate(p.trend, DISCORD_FIELD_VALUE_LIMIT), inline: true });
  }

  let description = "";

  if ((p.event === "flaky.detected" || p.event === "flaky.threshold.exceeded") && p.flaky_tests && p.flaky_tests.length > 0) {
    const flakyIcon = p.event === "flaky.threshold.exceeded" ? "\u26a0\ufe0f" : "\ud83c\udfb2";
    const lines = p.flaky_tests.slice(0, DISCORD_LIST_CAP).map((t) =>
      `${flakyIcon} **${truncate(t.full_title, 60)}** \u2014 ${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`
    );
    const more = discordOverflow(p.flaky_tests.length);
    if (more) lines.push(more);
    description = p.event === "flaky.threshold.exceeded"
      ? `**${p.flaky_tests.length} Test${p.flaky_tests.length > 1 ? "s" : ""} Over Flaky-Rate Threshold:**\n${lines.join("\n")}`
      : `**${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:**\n${lines.join("\n")}`;
  } else if (p.event === "new.failures" && p.new_failures && p.new_failures.length > 0) {
    const newLines = p.new_failures.slice(0, DISCORD_LIST_CAP).map((t) => {
      const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
      return `\ud83d\udea8 **${truncate(t.full_title, 60)}**${err}`;
    });
    const moreNew = discordOverflow(p.new_failures.length);
    if (moreNew) newLines.push(moreNew);
    description = `**${p.new_failures.length} New Failure${p.new_failures.length > 1 ? "s" : ""}** (passed last run):\n${newLines.join("\n")}`;

    if (p.failed_tests.length > p.new_failures.length) {
      description += `\n\n**All ${p.failed_tests.length} failures:**\n`;
      const allLines = p.failed_tests.slice(0, DISCORD_LIST_CAP).map((t) => {
        const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
        return `\u2022 **${truncate(t.full_title, 60)}**${err}`;
      });
      const moreAll = discordOverflow(p.failed_tests.length);
      if (moreAll) allLines.push(moreAll);
      description += allLines.join("\n");
    }
  } else if ((p.event === "error.regressed" || p.event === "error.autoclosed") && p.error_group) {
    const eg = p.error_group;
    const heading = p.event === "error.regressed"
      ? "**\ud83d\udd01 A previously-fixed failure reappeared:**"
      : "**\u2705 A failure went green and was auto-closed:**";
    const recur = eg.recurrence_count ? ` (recurred ${eg.recurrence_count}\u00d7)` : "";
    description = `${heading}\n${truncate(eg.error_message ?? "(no message)", 100)}\n\`${truncate(eg.suite_name, 60)}\` \u2014 now **${eg.status}**${recur}`;
  } else if (p.failed_tests.length > 0 && p.event !== "run.passed") {
    const lines = p.failed_tests.slice(0, DISCORD_LIST_CAP).map((t) => {
      const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
      return `\u2022 **${truncate(t.full_title, 60)}**${err}`;
    });
    const more = discordOverflow(p.failed_tests.length);
    if (more) lines.push(more);
    description = lines.join("\n");
  }

  if (description.length > 4000) {
    description = description.slice(0, 3997) + "\u2026";
  }

  return {
    embeds: [{
      title: truncate(title, DISCORD_TITLE_LIMIT),
      color: embedColor,
      url: p.error_group?.url ?? run.url,
      description,
      fields,
      footer: { text: "Flakey" },
      timestamp: new Date().toISOString(),
    }],
  };
}
