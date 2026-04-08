import { tenantQuery } from "./db.js";
import { formatPayload, type WebhookRunPayload } from "./webhook-formatters.js";
import type { NormalizedRun } from "./types.js";

export type { WebhookRunPayload };
// Keep backward compat
export type WebhookRunFailedPayload = WebhookRunPayload;

export async function dispatchWebhooks(orgId: number, event: string, payload: WebhookRunPayload): Promise<void> {
  const orgIdNum = Number(orgId);
  if (!orgIdNum || isNaN(orgIdNum) || !Number.isInteger(orgIdNum) || orgIdNum <= 0) return;
  try {
    const result = await tenantQuery(orgIdNum,
      "SELECT url, platform FROM webhooks WHERE org_id = $1 AND active = true AND $2 = ANY(events)",
      [orgIdNum, event]
    );

    for (const row of result.rows) {
      const body = formatPayload(row.platform, payload);
      fetch(row.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => {
        console.error(`Webhook dispatch to ${row.url} failed:`, err.message);
      });
    }
  } catch (err) {
    console.error("Webhook dispatch error:", err);
  }
}

/**
 * Dispatch all relevant webhook events for a completed run.
 */
export async function dispatchRunEvents(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  if (!orgId || typeof orgId !== "number" || !Number.isInteger(orgId) || orgId <= 0) return;
  const failedTests = run.specs.flatMap((spec) =>
    spec.tests
      .filter((t) => t.status === "failed")
      .map((t) => ({
        full_title: t.full_title,
        error_message: t.error?.message?.slice(0, 200) ?? null,
        spec_file: spec.file_path,
      }))
  ).slice(0, 10);

  // Get trend from recent runs
  const trendResult = await tenantQuery(orgId,
    `SELECT failed FROM runs WHERE suite_name = $1 AND id != $2
     ORDER BY created_at DESC LIMIT 5`,
    [run.meta.suite_name, runId]
  );
  const trendIcons = trendResult.rows
    .map((r) => (r.failed > 0 ? "\u274c" : "\u2705"))
    .reverse()
    .join("");
  const currentIcon = run.stats.failed > 0 ? "\u274c" : "\u2705";
  const trend = trendIcons + currentIcon;

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";

  const basePayload: WebhookRunPayload = {
    event: "",
    run: {
      id: runId,
      suite_name: run.meta.suite_name,
      branch: run.meta.branch,
      commit_sha: run.meta.commit_sha,
      duration_ms: run.stats.duration_ms,
      total: run.stats.total,
      passed: run.stats.passed,
      failed: run.stats.failed,
      skipped: run.stats.skipped,
      pending: run.stats.pending,
      url: `${frontendUrl}/runs/${runId}`,
    },
    failed_tests: failedTests,
    trend,
  };

  // run.completed — always fires
  dispatchWebhooks(orgId, "run.completed", { ...basePayload, event: "run.completed" });

  if (run.stats.failed > 0) {
    // run.failed
    dispatchWebhooks(orgId, "run.failed", { ...basePayload, event: "run.failed" });

    // new.failures — tests that passed in the previous run but fail now
    try {
      const prevRun = await tenantQuery(orgId,
        `SELECT id FROM runs WHERE suite_name = $1 AND id != $2
         ORDER BY created_at DESC LIMIT 1`,
        [run.meta.suite_name, runId]
      );

      if (prevRun.rows.length > 0) {
        const prevRunId = prevRun.rows[0].id;
        // Get tests that passed in previous run
        const prevPassed = await tenantQuery(orgId,
          `SELECT t.title, s.file_path
           FROM tests t JOIN specs s ON s.id = t.spec_id
           WHERE s.run_id = $1 AND t.status = 'passed'`,
          [prevRunId]
        );
        const passedSet = new Set(prevPassed.rows.map((r: any) => `${r.file_path}::${r.title}`));

        // Find current failures that were passing before
        const newFailures = run.specs.flatMap((spec) =>
          spec.tests
            .filter((t) => t.status === "failed" && passedSet.has(`${spec.file_path}::${t.title}`))
            .map((t) => ({
              full_title: t.full_title,
              error_message: t.error?.message?.slice(0, 200) ?? null,
              spec_file: spec.file_path,
            }))
        ).slice(0, 10);

        if (newFailures.length > 0) {
          dispatchWebhooks(orgId, "new.failures", {
            ...basePayload,
            event: "new.failures",
            new_failures: newFailures,
          });
        }
      }
    } catch (err) {
      console.error("new.failures detection error:", err);
    }
  } else {
    // run.passed
    dispatchWebhooks(orgId, "run.passed", { ...basePayload, event: "run.passed" });
  }

  // flaky.detected — check if any tests in this run are flaky (alternating pass/fail)
  try {
    const flakyResult = await tenantQuery(orgId,
      `WITH recent_runs AS (
        SELECT id, created_at FROM runs
        WHERE suite_name = $1
        ORDER BY created_at DESC LIMIT 20
      ),
      test_results AS (
        SELECT t.full_title, s.file_path, t.status, r.id AS run_id
        FROM tests t
        JOIN specs s ON s.id = t.spec_id
        JOIN recent_runs r ON r.id = s.run_id
        WHERE t.status IN ('passed', 'failed')
      )
      SELECT
        full_title, file_path,
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'passed')::int AS pass_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS fail_count,
        ARRAY_AGG(status ORDER BY run_id ASC) AS timeline
      FROM test_results
      GROUP BY full_title, file_path
      HAVING COUNT(*) FILTER (WHERE status = 'passed') > 0
         AND COUNT(*) FILTER (WHERE status = 'failed') > 0
         AND COUNT(*) >= 3`,
      [run.meta.suite_name]
    );

    if (flakyResult.rows.length > 0) {
      const flakyTests = flakyResult.rows.map((row: any) => {
        const timeline: string[] = row.timeline;
        let flipCount = 0;
        for (let i = 1; i < timeline.length; i++) {
          if (timeline[i] !== timeline[i - 1]) flipCount++;
        }
        return {
          full_title: row.full_title,
          file_path: row.file_path,
          flaky_rate: Math.round((row.fail_count / row.total_runs) * 1000) / 10,
          flip_count: flipCount,
          fail_count: row.fail_count,
          total_runs: row.total_runs,
        };
      }).filter((t: any) => t.flip_count >= 2) // At least 2 flips to be considered flaky
        .slice(0, 10);

      if (flakyTests.length > 0) {
        dispatchWebhooks(orgId, "flaky.detected", {
          ...basePayload,
          event: "flaky.detected",
          flaky_tests: flakyTests,
        });
      }
    }
  } catch (err) {
    console.error("flaky.detected detection error:", err);
  }
}

// Keep backward compat
export const dispatchRunFailed = dispatchRunEvents;
