import pool from "./db.js";
import { tenantQuery } from "./db.js";
import { formatPayload, type WebhookRunPayload } from "./webhook-formatters.js";
import type { NormalizedRun } from "./types.js";

export type { WebhookRunPayload };
// Keep backward compat
export type WebhookRunFailedPayload = WebhookRunPayload;

export async function dispatchWebhooks(orgId: number, event: string, payload: WebhookRunPayload): Promise<void> {
  if (!orgId || typeof orgId !== "number") return;
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
 * Dispatch all relevant webhook events for a completed run.
 */
export async function dispatchRunEvents(orgId: number, runId: number, run: NormalizedRun): Promise<void> {
  if (!orgId || typeof orgId !== "number") return;
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
}

// Keep backward compat
export const dispatchRunFailed = dispatchRunEvents;
