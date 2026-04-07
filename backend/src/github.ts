import pool from "./db.js";
import { tenantQuery } from "./db.js";
import type { NormalizedRun } from "./types.js";

const COMMENT_MARKER = "<!-- flakey-pr-comment -->";

interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

async function getGitHubConfig(orgId: number): Promise<GitHubConfig | null> {
  const result = await pool.query(
    "SELECT github_token, github_repo FROM organizations WHERE id = $1",
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.github_token || !row?.github_repo) return null;

  const parts = row.github_repo.split("/");
  if (parts.length !== 2) return null;

  return { token: row.github_token, owner: parts[0], repo: parts[1] };
}

async function githubApi(config: GitHubConfig, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
}

async function findPRByCommit(config: GitHubConfig, commitSha: string): Promise<number | null> {
  const res = await githubApi(config, `/repos/${config.owner}/${config.repo}/commits/${commitSha}/pulls`);
  if (!res.ok) return null;
  const pulls = await res.json() as Array<{ number: number; state: string }>;
  const open = pulls.find((p) => p.state === "open");
  return open?.number ?? pulls[0]?.number ?? null;
}

async function findPRByBranch(config: GitHubConfig, branch: string): Promise<number | null> {
  const res = await githubApi(config, `/repos/${config.owner}/${config.repo}/pulls?head=${config.owner}:${branch}&state=open`);
  if (!res.ok) return null;
  const pulls = await res.json() as Array<{ number: number }>;
  return pulls[0]?.number ?? null;
}

async function findExistingComment(config: GitHubConfig, prNumber: number): Promise<number | null> {
  const res = await githubApi(config, `/repos/${config.owner}/${config.repo}/issues/${prNumber}/comments?per_page=100`);
  if (!res.ok) return null;
  const comments = await res.json() as Array<{ id: number; body: string }>;
  const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
  return existing?.id ?? null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function buildCommentBody(
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
  body += `## ${statusIcon} Test Results — ${meta.suite_name}\n\n`;

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

  // Failed tests
  if (stats.failed > 0) {
    const failedTests = run.specs.flatMap((spec) =>
      spec.tests
        .filter((t) => t.status === "failed")
        .map((t) => ({ title: t.full_title, error: t.error?.message, spec: spec.file_path }))
    );

    body += `<details${failedTests.length <= 5 ? " open" : ""}>\n`;
    body += `<summary><strong>\u274c ${failedTests.length} Failed Test${failedTests.length !== 1 ? "s" : ""}</strong></summary>\n\n`;

    for (const t of failedTests.slice(0, 20)) {
      body += `- **${t.title}** — \`${t.spec}\`\n`;
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

  // Flaky tests
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

/**
 * Post or update a PR comment with test results.
 * Fires and forgets — errors are logged but don't affect the upload response.
 */
export async function postPRComment(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  try {
    const config = await getGitHubConfig(orgId);
    if (!config) return;

    const { meta } = run;
    if (!meta.commit_sha && !meta.branch) return;

    // Find the PR
    let prNumber: number | null = null;
    if (meta.commit_sha) {
      prNumber = await findPRByCommit(config, meta.commit_sha);
    }
    if (!prNumber && meta.branch) {
      prNumber = await findPRByBranch(config, meta.branch);
    }
    if (!prNumber) return;

    // Build trend sparkline from recent runs
    const trendResult = await tenantQuery(orgId,
      `SELECT failed FROM runs WHERE suite_name = $1 AND id != $2
       ORDER BY created_at DESC LIMIT 5`,
      [meta.suite_name, runId]
    );
    const trendIcons = trendResult.rows
      .map((r) => (r.failed > 0 ? "\u274c" : "\u2705"))
      .reverse()
      .join("");
    const currentIcon = run.stats.failed > 0 ? "\u274c" : "\u2705";
    const trend = trendIcons + currentIcon;

    // Detect flaky tests: tests that passed in this run but failed in the previous run (or vice versa)
    const flakyTests: string[] = [];
    const prevRunResult = await tenantQuery(orgId,
      `SELECT id FROM runs WHERE suite_name = $1 AND id < $2
       ORDER BY created_at DESC LIMIT 1`,
      [meta.suite_name, runId]
    );
    if (prevRunResult.rows.length > 0) {
      const prevRunId = prevRunResult.rows[0].id;
      // Find tests that changed status between runs
      const flakyResult = await tenantQuery(orgId,
        `SELECT DISTINCT t1.full_title
         FROM tests t1
         JOIN specs s1 ON s1.id = t1.spec_id AND s1.run_id = $1
         JOIN specs s2 ON s2.run_id = $2
         JOIN tests t2 ON t2.spec_id = s2.id AND t2.full_title = t1.full_title
         WHERE t1.status = 'passed' AND t2.status = 'failed'
            OR t1.status = 'failed' AND t2.status = 'passed'
         LIMIT 20`,
        [runId, prevRunId]
      );
      for (const row of flakyResult.rows) {
        flakyTests.push(row.full_title);
      }
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";
    const commentBody = buildCommentBody(run, runId, frontendUrl, trend, flakyTests);

    // Check for existing Flakey comment to update
    const existingCommentId = await findExistingComment(config, prNumber);

    if (existingCommentId) {
      await githubApi(config, `/repos/${config.owner}/${config.repo}/issues/comments/${existingCommentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentBody }),
      });
    } else {
      await githubApi(config, `/repos/${config.owner}/${config.repo}/issues/${prNumber}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentBody }),
      });
    }
  } catch (err) {
    console.error("GitHub PR comment error:", err);
  }
}
