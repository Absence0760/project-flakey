import pool from "./db.js";
import { tenantQuery } from "./db.js";
import { formatPayload, type WebhookRunFailedPayload } from "./webhook-formatters.js";
import type { NormalizedRun } from "./types.js";

export type { WebhookRunFailedPayload };

export async function dispatchWebhooks(orgId: number, event: string, payload: WebhookRunFailedPayload): Promise<void> {
  if (!orgId) return;
  try {
    const result = await pool.query(
      "SELECT url, platform FROM webhooks WHERE org_id = $1 AND active = true AND $2 = ANY(events)",
      [orgId, event]
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
 * Build a rich payload from a normalized run and dispatch the run.failed webhook.
 */
export async function dispatchRunFailed(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  const failedTests = run.specs.flatMap((spec) =>
    spec.tests
      .filter((t) => t.status === "failed")
      .map((t) => ({
        full_title: t.full_title,
        error_message: t.error?.message?.slice(0, 200) ?? null,
        spec_file: spec.file_path,
      }))
  ).slice(0, 10);

  const trendResult = await tenantQuery(orgId,
    `SELECT failed FROM runs WHERE suite_name = $1 AND id != $2
     ORDER BY created_at DESC LIMIT 5`,
    [run.meta.suite_name, runId]
  );
  const trendIcons = trendResult.rows
    .map((r) => (r.failed > 0 ? "\u274c" : "\u2705"))
    .reverse()
    .join("");
  const trend = trendIcons + "\u274c"; // current run failed

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";

  dispatchWebhooks(orgId, "run.failed", {
    event: "run.failed",
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
  });
}
