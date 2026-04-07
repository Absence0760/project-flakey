import pool from "../db.js";
import { tenantQuery } from "../db.js";
import type { NormalizedRun } from "../types.js";
import type { GitProvider, GitProviderConfig, GitPlatform } from "./types.js";
import { createGitHubProvider } from "./github.js";
import { createGitLabProvider } from "./gitlab.js";
import { createBitbucketProvider } from "./bitbucket.js";
import { buildCommentBody } from "./comment.js";

async function getProviderConfig(orgId: number): Promise<GitProviderConfig | null> {
  const result = await pool.query(
    "SELECT git_provider, git_token, git_repo, git_base_url FROM organizations WHERE id = $1",
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.git_provider || !row?.git_token || !row?.git_repo) return null;

  return {
    platform: row.git_provider as GitPlatform,
    token: row.git_token,
    repo: row.git_repo,
    baseUrl: row.git_base_url ?? undefined,
  };
}

function createProvider(config: GitProviderConfig): GitProvider {
  switch (config.platform) {
    case "github": return createGitHubProvider(config);
    case "gitlab": return createGitLabProvider(config);
    case "bitbucket": return createBitbucketProvider(config);
  }
}

/**
 * Post or update a PR/MR comment with test results.
 * Fires and forgets — errors are logged but don't affect the upload response.
 */
export async function postPRComment(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  try {
    const config = await getProviderConfig(orgId);
    if (!config) return;

    const { meta } = run;
    if (!meta.commit_sha && !meta.branch) return;

    const provider = createProvider(config);

    // Find the PR/MR
    let prId: number | null = null;
    if (meta.commit_sha) {
      prId = await provider.findPRByCommit(meta.commit_sha);
    }
    if (!prId && meta.branch) {
      prId = await provider.findPRByBranch(meta.branch);
    }
    if (!prId) return;

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

    // Detect flaky tests: tests that changed status between this run and the previous one
    const flakyTests: string[] = [];
    const prevRunResult = await tenantQuery(orgId,
      `SELECT id FROM runs WHERE suite_name = $1 AND id < $2
       ORDER BY created_at DESC LIMIT 1`,
      [meta.suite_name, runId]
    );
    if (prevRunResult.rows.length > 0) {
      const prevRunId = prevRunResult.rows[0].id;
      const flakyResult = await tenantQuery(orgId,
        `SELECT DISTINCT t1.full_title
         FROM tests t1
         JOIN specs s1 ON s1.id = t1.spec_id AND s1.run_id = $1
         JOIN specs s2 ON s2.run_id = $2
         JOIN tests t2 ON t2.spec_id = s2.id AND t2.full_title = t1.full_title
         WHERE (t1.status = 'passed' AND t2.status = 'failed')
            OR (t1.status = 'failed' AND t2.status = 'passed')
         LIMIT 20`,
        [runId, prevRunId]
      );
      for (const row of flakyResult.rows) {
        flakyTests.push(row.full_title);
      }
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";
    const commentBody = buildCommentBody(run, runId, frontendUrl, trend, flakyTests);

    // Post or update existing comment
    const existingCommentId = await provider.findExistingComment(prId);

    if (existingCommentId) {
      await provider.updateComment(prId, existingCommentId, commentBody);
    } else {
      await provider.createComment(prId, commentBody);
    }
  } catch (err) {
    console.error("PR comment error:", err);
  }
}
