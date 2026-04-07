import type { NormalizedRun } from "../types.js";

export const COMMENT_MARKER = "<!-- flakey-pr-comment -->";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

export function buildCommentBody(
  run: NormalizedRun,
  runId: number,
  frontendUrl: string,
  trend: string,
  flakyTests: string[]
): string {
  const { stats, meta } = run;
  const passRate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : "0.0";
  const runUrl = `${frontendUrl}/runs/${runId}`;

  const statusIcon = stats.failed > 0 ? "\u274c" : "\u2705";
  const statusText = stats.failed > 0 ? "Failed" : "Passed";

  let body = `${COMMENT_MARKER}\n`;
  body += `## ${statusIcon} Test Results \u2014 ${meta.suite_name}\n\n`;

  body += `| Metric | Value |\n|--------|-------|\n`;
  body += `| **Status** | ${statusText} |\n`;
  body += `| **Pass Rate** | ${passRate}% (${stats.passed}/${stats.total}) |\n`;
  body += `| **Failed** | ${stats.failed} |\n`;
  body += `| **Skipped** | ${stats.skipped} |\n`;
  body += `| **Duration** | ${formatDuration(stats.duration_ms)} |\n`;

  if (trend) {
    body += `| **Recent** | ${trend} |\n`;
  }

  body += `\n`;

  if (stats.failed > 0) {
    const failedTests = run.specs.flatMap((spec) =>
      spec.tests
        .filter((t) => t.status === "failed")
        .map((t) => ({ title: t.full_title, error: t.error?.message, spec: spec.file_path }))
    );

    body += `<details${failedTests.length <= 5 ? " open" : ""}>\n`;
    body += `<summary><strong>\u274c ${failedTests.length} Failed Test${failedTests.length !== 1 ? "s" : ""}</strong></summary>\n\n`;

    for (const t of failedTests.slice(0, 20)) {
      body += `- **${t.title}** \u2014 \`${t.spec}\`\n`;
      if (t.error) {
        const truncated = t.error.length > 200 ? t.error.slice(0, 197) + "..." : t.error;
        body += `  > ${truncated}\n`;
      }
    }
    if (failedTests.length > 20) {
      body += `\n_...and ${failedTests.length - 20} more_\n`;
    }

    body += `\n</details>\n\n`;
  }

  if (flakyTests.length > 0) {
    body += `<details>\n`;
    body += `<summary><strong>\u26a0\ufe0f ${flakyTests.length} Flaky Test${flakyTests.length !== 1 ? "s" : ""}</strong></summary>\n\n`;
    for (const title of flakyTests.slice(0, 10)) {
      body += `- ${title}\n`;
    }
    body += `\n</details>\n\n`;
  }

  body += `[View full report \u2192](${runUrl})\n\n`;
  body += `---\n*Posted by [Flakey](${frontendUrl})*`;

  return body;
}
