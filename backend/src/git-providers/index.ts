import pool from "../db.js";
import { tenantQuery } from "../db.js";
import type { NormalizedRun } from "../types.js";
import type { GitProvider, GitProviderConfig, GitPlatform } from "./types.js";
import { buildCheckAnnotations } from "./annotations.js";
import { createGitHubProvider } from "./github.js";
import { createGitLabProvider } from "./gitlab.js";
import { createBitbucketProvider } from "./bitbucket.js";
import { buildCommentBody } from "./comment.js";

async function getProviderConfig(orgId: number): Promise<GitProviderConfig | null> {
  // `organizations` has no RLS — see backend/src/routes/orgs.ts header.
  // orgId is always trusted; WHERE id = $1 is the tenant boundary.
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
 * Post or update a PR/MR comment with test results, and set commit status.
 * Fires and forgets — errors are logged but don't affect the upload response.
 */
export async function postPRComment(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  try {
    const config = await getProviderConfig(orgId);
    if (!config) return;

    const { meta } = run;
    if (!meta.commit_sha && !meta.branch) return;

    const provider = createProvider(config);
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";

    // DELIBERATE ASYMMETRY: when a run has failures but every failed test is
    // quarantined for this suite, we relax only the *external* git merge gate
    // (commit status / Checks conclusion below). classifyRunStatus() and the
    // badge intentionally keep reporting "failed" — the Flakey dashboard never
    // lies; quarantine just stops a known-flaky test from blocking the PR.
    // Best-effort like everything else here: a failed quarantine lookup falls
    // back to the honest failure state and must not throw out of this function.
    let allFailuresQuarantined = false;
    if (run.stats.failed > 0) {
      const failedTitles = run.specs
        .flatMap((s) => s.tests)
        .filter((t) => t.status === "failed")
        .map((t) => t.full_title);
      try {
        const quarantinedResult = await tenantQuery(orgId,
          "SELECT full_title FROM quarantined_tests WHERE suite_name = $1",
          [meta.suite_name]
        );
        const quarantined = new Set<string>(quarantinedResult.rows.map((r) => r.full_title));
        const nonQuarantinedFailed = failedTitles.filter((t) => !quarantined.has(t)).length;
        // Require at least one actual failed title to compare against: if a
        // normalizer ever reports stats.failed > 0 with no status==='failed'
        // tests in specs, failedTitles is empty and `=== 0` would vacuously
        // soften a genuinely-failed run (fail-open). Fail closed instead.
        allFailuresQuarantined = failedTitles.length > 0 && nonQuarantinedFailed === 0;
      } catch (err) {
        console.error("Quarantine lookup error:", err);
        allFailuresQuarantined = false; // fall back to the honest failure state
      }
    }

    // Post commit status check (independent of PR existence)
    if (meta.commit_sha) {
      const passRate = run.stats.total > 0 ? ((run.stats.passed / run.stats.total) * 100).toFixed(1) : "0";
      try {
        await provider.postCommitStatus({
          commitSha: meta.commit_sha,
          // Quarantined-only failures don't block the merge (GitLab/Bitbucket
          // have no neutral state, so "success" is how they unblock too).
          state: run.stats.failed > 0 && !allFailuresQuarantined ? "failure" : "success",
          targetUrl: `${frontendUrl}/runs/${runId}`,
          description: allFailuresQuarantined
            ? `${run.stats.failed} quarantined (flaky) — not blocking`
            : run.stats.failed > 0
              ? `${run.stats.failed} failed, ${run.stats.passed} passed (${passRate}%)`
              : `${run.stats.passed} passed (${passRate}%)`,
          context: `flakey/${meta.suite_name}`,
        });
      } catch (err) {
        console.error("Commit status error:", err);
      }

      // Rich per-failure annotations on the diff (GitHub only — the Checks API).
      // Independent of PR existence (annotations attach to the commit). Best-
      // effort + fire-and-forget, like the status above; a token without
      // checks:write surfaces here as a logged 403 and never blocks the upload.
      if (provider.postChecksAnnotations) {
        try {
          const annotations = buildCheckAnnotations(run);
          const passRate = run.stats.total > 0 ? ((run.stats.passed / run.stats.total) * 100).toFixed(1) : "0";
          await provider.postChecksAnnotations({
            commitSha: meta.commit_sha,
            name: `flakey/${meta.suite_name}`,
            title: allFailuresQuarantined
              ? `${run.stats.failed} quarantined (flaky) — not blocking`
              : run.stats.failed > 0
                ? `${run.stats.failed} failed, ${run.stats.passed} passed (${passRate}%)`
                : `${run.stats.passed} passed (${passRate}%)`,
            summary: `[View the full run in Flakey](${frontendUrl}/runs/${runId})`,
            // "neutral" surfaces the failures without failing the required check.
            conclusion: allFailuresQuarantined ? "neutral" : run.stats.failed > 0 ? "failure" : "success",
            detailsUrl: `${frontendUrl}/runs/${runId}`,
            annotations,
          });
        } catch (err) {
          console.error("Checks annotations error:", err);
        }
      }
    }

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

    // Detect flaky tests: tests that changed status between this run and the previous one.
    // NOTE: this is a distinct 2-run (this-vs-previous) diff, NOT the N-run windowed
    // detection in flaky-analysis.ts — intentionally kept separate.
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
