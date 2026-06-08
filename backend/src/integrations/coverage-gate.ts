import pool from "../db.js";
import { decryptSecret } from "../crypto.js";
import { createGitHubProvider } from "../git-providers/github.js";
import { createGitLabProvider } from "../git-providers/gitlab.js";
import { createBitbucketProvider } from "../git-providers/bitbucket.js";
import type { GitProviderConfig } from "../git-providers/types.js";

async function getConfig(orgId: number): Promise<GitProviderConfig | null> {
  // `organizations` has no RLS — see backend/src/routes/orgs.ts header.
  // orgId is always trusted (req.user.orgId or run.org_id); WHERE id = $1
  // is the tenant boundary.
  const result = await pool.query(
    "SELECT git_provider, git_token, git_repo, git_base_url FROM organizations WHERE id = $1",
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.git_provider || !row?.git_token || !row?.git_repo) return null;
  // Decrypt git_token; fall back to raw value for legacy unencrypted rows
  // (in-place migration: the next write via PATCH /orgs/:id/settings will
  // re-encrypt the token automatically).
  let token: string;
  try {
    token = decryptSecret(row.git_token) ?? row.git_token;
  } catch {
    token = row.git_token;
  }
  return {
    platform: row.git_provider,
    token,
    repo: row.git_repo,
    baseUrl: row.git_base_url ?? undefined,
  };
}

/**
 * Format a coverage percentage for the status description so the rendered
 * number can never contradict the gate decision. `toFixed(1)` rounds half-up,
 * so 79.96% against an 80% threshold (a fail) renders "80.0" and the status
 * reads the contradictory "Coverage 80.0% < 80%". `pass` is the *exact*
 * decision (`linesPct >= threshold`), passed in rather than re-derived here —
 * we only widen the displayed precision until the shown number lands on the
 * same side of the threshold as that decision. One decimal in the common case.
 */
export function formatCoveragePct(linesPct: number, threshold: number, pass: boolean): string {
  for (let dp = 1; dp <= 6; dp++) {
    const shown = Number(linesPct.toFixed(dp));
    if (pass ? shown >= threshold : shown < threshold) return linesPct.toFixed(dp);
  }
  // Within ~1e-6 of the threshold — round in the safe direction so the display
  // still never crosses it (down on a fail, up on a pass).
  const factor = 1e6;
  const safe = pass ? Math.ceil(linesPct * factor) / factor : Math.floor(linesPct * factor) / factor;
  return String(safe);
}

/**
 * Pure gate decision + status description. Exported so the threshold logic and
 * the contradiction-free formatting are unit-testable without postCoverageStatus's
 * DB lookup and provider HTTP call.
 */
export function coverageStatusContent(
  linesPct: number,
  threshold: number,
): { state: "success" | "failure"; description: string } {
  const pass = linesPct >= threshold;
  const shown = formatCoveragePct(linesPct, threshold, pass);
  return {
    state: pass ? "success" : "failure",
    description: pass ? `Coverage ${shown}% ≥ ${threshold}%` : `Coverage ${shown}% < ${threshold}%`,
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

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";
  const { state, description } = coverageStatusContent(linesPct, threshold);

  try {
    await provider.postCommitStatus({
      commitSha,
      state,
      targetUrl: `${frontendUrl}/runs/${runId}`,
      description,
      context: `flakey/coverage/${suiteName}`,
    });
  } catch (err) {
    console.error("postCoverageStatus error:", (err as Error).message);
  }
}
