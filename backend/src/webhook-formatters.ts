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

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "n/a";
}

// --- Generic (backward-compatible) ---

function formatGeneric(p: WebhookRunFailedPayload): object {
  const text = p.event === "flaky.detected"
    ? `Run #${p.run.id}: ${p.flaky_tests?.length ?? 0} flaky test(s) detected in '${p.run.suite_name}'`
    : `Run #${p.run.id} failed: ${p.run.failed}/${p.run.total} tests failed in suite '${p.run.suite_name}'`;
  return {
    text,
    event: p.event,
    run: p.run,
    failed_tests: p.failed_tests,
    ...(p.flaky_tests ? { flaky_tests: p.flaky_tests } : {}),
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
      text: { type: "plain_text", text: title, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Branch:*\n${run.branch || "n/a"}` },
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
    const lines = p.new_failures.map((t) => {
      const err = t.error_message ? `\n> ${truncate(t.error_message, 150)}` : "";
      return `\u2022 \`${truncate(t.spec_file, 40)}\` \u2014 *${truncate(t.full_title, 80)}*${err}`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  // Flaky tests section
  if (p.event === "flaky.detected" && p.flaky_tests && p.flaky_tests.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*\ud83c\udfb2 ${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:*` },
    });
    const lines = p.flaky_tests.map((t) =>
      `\u2022 *${truncate(t.full_title, 80)}*\n>  \`${truncate(t.file_path, 40)}\` \u2014 ${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`
    );
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  if (p.failed_tests.length > 0 && p.event !== "run.passed" && p.event !== "flaky.detected") {
    if (p.event !== "new.failures") {
      blocks.push({ type: "divider" });
    }
    // For new.failures, also show all failures below if there are more than just the new ones
    if (p.event === "new.failures" && p.failed_tests.length > (p.new_failures?.length ?? 0)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*All ${p.failed_tests.length} failures:*` },
      });
    }
    if (p.event !== "new.failures") {
      const lines = p.failed_tests.map((t) => {
        const err = t.error_message ? `\n> ${truncate(t.error_message, 150)}` : "";
        return `\u2022 \`${truncate(t.spec_file, 40)}\` \u2014 *${truncate(t.full_title, 80)}*${err}`;
      });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      });
    }
  }

  blocks.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "View Run" }, url: run.url },
    ],
  });

  const fallback = p.event === "run.passed"
    ? `Run #${run.id} passed: ${run.passed}/${run.total} tests in '${run.suite_name}'`
    : p.event === "new.failures"
    ? `Run #${run.id}: ${p.new_failures?.length ?? 0} new failure(s) in '${run.suite_name}'`
    : p.event === "flaky.detected"
    ? `Run #${run.id}: ${p.flaky_tests?.length ?? 0} flaky test(s) in '${run.suite_name}'`
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
      text: title,
    },
    {
      type: "FactSet",
      facts: [
        { title: "Branch", value: run.branch || "n/a" },
        { title: "Commit", value: shortSha(run.commit_sha) },
        { title: "Duration", value: formatDuration(run.duration_ms) },
        { title: "Results", value: `${run.failed} failed / ${run.passed} passed / ${run.skipped} skipped` },
        { title: "Recent", value: p.trend || "n/a" },
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
    for (const t of p.new_failures) {
      const err = t.error_message ? `\n\n${truncate(t.error_message, 150)}` : "";
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.spec_file, 40)}\`${err}`,
        wrap: true,
        size: "Small",
      });
    }
  }

  if (p.event === "flaky.detected" && p.flaky_tests && p.flaky_tests.length > 0) {
    body.push({
      type: "TextBlock",
      text: `**\ud83c\udfb2 ${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:**`,
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const t of p.flaky_tests) {
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.file_path, 40)}\`\n\n${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`,
        wrap: true,
        size: "Small",
      });
    }
  }

  if (p.failed_tests.length > 0 && p.event !== "run.passed" && p.event !== "flaky.detected") {
    body.push({
      type: "TextBlock",
      text: p.event === "new.failures" ? "**All Failures:**" : "**Failed Tests**",
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const t of p.failed_tests) {
      const err = t.error_message ? `\n\n${truncate(t.error_message, 150)}` : "";
      body.push({
        type: "TextBlock",
        text: `\u2022 **${truncate(t.full_title, 80)}** \u2014 \`${truncate(t.spec_file, 40)}\`${err}`,
        wrap: true,
        size: "Small",
      });
    }
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
          { type: "Action.OpenUrl", title: "View Run", url: run.url },
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
    : p.event === "flaky.detected" ? 0xf59e0b
    : p.event === "new.failures" ? 0xff8800
    : 0xff4444;

  const fields = [
    { name: "Suite", value: run.suite_name, inline: true },
    { name: "Branch", value: run.branch || "n/a", inline: true },
    { name: "Commit", value: `\`${shortSha(run.commit_sha)}\``, inline: true },
    { name: "Results", value: `\u274c ${run.failed} failed \u2002\u2705 ${run.passed} passed \u2002\u23e9 ${run.skipped} skipped`, inline: false },
    { name: "Duration", value: formatDuration(run.duration_ms), inline: true },
  ];

  if (p.trend) {
    fields.push({ name: "Recent", value: p.trend, inline: true });
  }

  let description = "";

  if (p.event === "flaky.detected" && p.flaky_tests && p.flaky_tests.length > 0) {
    const lines = p.flaky_tests.map((t) =>
      `\ud83c\udfb2 **${truncate(t.full_title, 60)}** \u2014 ${t.flaky_rate}% flaky (${t.fail_count}/${t.total_runs} failed, ${t.flip_count} flips)`
    );
    description = `**${p.flaky_tests.length} Flaky Test${p.flaky_tests.length > 1 ? "s" : ""} Detected:**\n${lines.join("\n")}`;
  } else if (p.event === "new.failures" && p.new_failures && p.new_failures.length > 0) {
    const newLines = p.new_failures.map((t) => {
      const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
      return `\ud83d\udea8 **${truncate(t.full_title, 60)}**${err}`;
    });
    description = `**${p.new_failures.length} New Failure${p.new_failures.length > 1 ? "s" : ""}** (passed last run):\n${newLines.join("\n")}`;

    if (p.failed_tests.length > p.new_failures.length) {
      description += `\n\n**All ${p.failed_tests.length} failures:**\n`;
      const allLines = p.failed_tests.map((t) => {
        const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
        return `\u2022 **${truncate(t.full_title, 60)}**${err}`;
      });
      description += allLines.join("\n");
    }
  } else if (p.failed_tests.length > 0 && p.event !== "run.passed") {
    const lines = p.failed_tests.map((t) => {
      const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
      return `\u2022 **${truncate(t.full_title, 60)}**${err}`;
    });
    description = lines.join("\n");
  }

  if (description.length > 4000) {
    description = description.slice(0, 3997) + "\u2026";
  }

  return {
    embeds: [{
      title,
      color: embedColor,
      url: run.url,
      description,
      fields,
      footer: { text: "Flakey" },
      timestamp: new Date().toISOString(),
    }],
  };
}
