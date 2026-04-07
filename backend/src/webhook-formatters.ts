export interface WebhookRunFailedPayload {
  event: "run.failed";
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
  trend: string;
}

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
  return {
    text: `Run #${p.run.id} failed: ${p.run.failed}/${p.run.total} tests failed in suite '${p.run.suite_name}'`,
    event: p.event,
    run: p.run,
    failed_tests: p.failed_tests,
    trend: p.trend,
  };
}

// --- Slack Block Kit ---

function formatSlack(p: WebhookRunFailedPayload): object {
  const { run } = p;
  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `\u274c Run #${run.id} Failed \u2014 ${run.suite_name}`, emoji: true },
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

  if (p.failed_tests.length > 0) {
    blocks.push({ type: "divider" });
    const lines = p.failed_tests.map((t) => {
      const err = t.error_message ? `\n> ${truncate(t.error_message, 150)}` : "";
      return `\u2022 \`${truncate(t.spec_file, 40)}\` \u2014 *${truncate(t.full_title, 80)}*${err}`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "View Run" }, url: run.url },
    ],
  });

  return {
    text: `Run #${run.id} failed: ${run.failed}/${run.total} tests failed in '${run.suite_name}'`,
    blocks,
  };
}

// --- Microsoft Teams Adaptive Card ---

function formatTeams(p: WebhookRunFailedPayload): object {
  const { run } = p;
  const body: object[] = [
    {
      type: "TextBlock",
      size: "Large",
      weight: "Bolder",
      color: "Attention",
      text: `\u274c Run #${run.id} Failed \u2014 ${run.suite_name}`,
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

  if (p.failed_tests.length > 0) {
    body.push({
      type: "TextBlock",
      text: "**Failed Tests**",
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
        fallbackText: `Run #${run.id} Failed \u2014 ${run.failed}/${run.total} tests failed in '${run.suite_name}'`,
        body,
        actions: [
          { type: "Action.OpenUrl", title: "View Run", url: run.url },
        ],
      },
    }],
  };
}

// --- Discord Embed ---

function formatDiscord(p: WebhookRunFailedPayload): object {
  const { run } = p;

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
  if (p.failed_tests.length > 0) {
    const lines = p.failed_tests.map((t) => {
      const err = t.error_message ? ` \u2014 ${truncate(t.error_message, 100)}` : "";
      return `\u2022 **${truncate(t.full_title, 60)}**${err}`;
    });
    description = lines.join("\n");
    // Discord embed description limit is 4096 chars
    if (description.length > 4000) {
      description = description.slice(0, 3997) + "\u2026";
    }
  }

  return {
    embeds: [{
      title: `Run #${run.id} Failed`,
      color: 0xff4444,
      url: run.url,
      description,
      fields,
      footer: { text: "Flakey" },
      timestamp: new Date().toISOString(),
    }],
  };
}
