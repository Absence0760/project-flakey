import pool from "../db.js";
import { createGitHubProvider } from "../git-providers/github.js";
import { createGitLabProvider } from "../git-providers/gitlab.js";
import { createBitbucketProvider } from "../git-providers/bitbucket.js";
import type { GitProviderConfig } from "../git-providers/types.js";

async function getConfig(orgId: number): Promise<GitProviderConfig | null> {
  const result = await pool.query(
    "SELECT git_provider, git_token, git_repo, git_base_url FROM organizations WHERE id = $1",
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.git_provider || !row?.git_token || !row?.git_repo) return null;
  return {
    platform: row.git_provider,
    token: row.git_token,
    repo: row.git_repo,
    baseUrl: row.git_base_url ?? undefined,
  };
}

/**
 * Post a commit status with the coverage gate result, using whichever git
 * provider the org has configured. Swallows errors.
 */
export async function postCoverageStatus(
  orgId: number,
  commitSha: string,
  linesPct: number,
  threshold: number,
  runId: number,
  suiteName: string
): Promise<void> {
  const cfg = await getConfig(orgId);
  if (!cfg) return;

  const provider =
    cfg.platform === "github" ? createGitHubProvider(cfg)
    : cfg.platform === "gitlab" ? createGitLabProvider(cfg)
    : createBitbucketProvider(cfg);

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";
  const pass = linesPct >= threshold;

  try {
    await provider.postCommitStatus({
      commitSha,
      state: pass ? "success" : "failure",
      targetUrl: `${frontendUrl}/runs/${runId}`,
      description: pass
        ? `Coverage ${linesPct.toFixed(1)}% ≥ ${threshold}%`
        : `Coverage ${linesPct.toFixed(1)}% < ${threshold}%`,
      context: `flakey/coverage/${suiteName}`,
    });
  } catch (err) {
    console.error("postCoverageStatus error:", (err as Error).message);
  }
}
