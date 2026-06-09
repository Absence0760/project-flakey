import { tenantQuery } from "./db.js";
import { computeFlakyTests } from "./flaky-analysis.js";
import { formatPayload, type WebhookRunPayload } from "./webhook-formatters.js";
import type { NormalizedRun } from "./types.js";

export type { WebhookRunPayload };
// Keep backward compat
export type WebhookRunFailedPayload = WebhookRunPayload;

/**
 * Fire a single webhook delivery. Best-effort: catches every failure
 * mode (URL parse error, JSON.stringify throw, network failure) and
 * logs without rethrowing, so a malformed row in `webhooks` cannot
 * abort the dispatch loop's later iterations.
 *
 * Has a 10s timeout — without it, a hung receiver leaks an open socket
 * indefinitely (the surrounding fire-and-forget pattern means nobody
 * is waiting on the promise to enforce timeout for us).
 */
export function sendWebhook(url: string, platform: string, payload: WebhookRunPayload): void {
  let body: string;
  try {
    body = JSON.stringify(formatPayload(platform, payload));
  } catch (err) {
    // formatPayload returning a value with a BigInt / circular ref / etc.
    // shouldn't kill the rest of the loop.
    console.error(`Webhook formatter failed for ${url}:`, (err as Error).message);
    return;
  }

  // fetch() throws synchronously on a malformed URL — wrap the call site
  // (not just .catch) so one bad row doesn't abort dispatch to the rest.
  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      console.error(`Webhook dispatch to ${url} failed:`, err.message);
    });
  } catch (err) {
    console.error(`Webhook dispatch to ${url} failed (sync):`, (err as Error).message);
  }
}

export async function dispatchWebhooks(orgId: number, event: string, payload: WebhookRunPayload): Promise<void> {
  const orgIdNum = Number(orgId);
  if (!orgIdNum || isNaN(orgIdNum) || !Number.isInteger(orgIdNum) || orgIdNum <= 0) return;
  try {
    const result = await tenantQuery(orgIdNum,
      "SELECT url, platform FROM webhooks WHERE org_id = $1 AND active = true AND $2 = ANY(events)",
      [orgIdNum, event]
    );

    for (const row of result.rows) {
      sendWebhook(row.url, row.platform, payload);
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

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";

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
    // Windowed (20-run) flaky detection via the shared module. The SQL HAVING
    // already requires both a pass and a fail; we keep the >= 3 total-runs
    // floor and the >= 2 flips threshold here.
    const candidates = await computeFlakyTests(orgId, {
      suite: run.meta.suite_name,
      runWindow: 20,
      // Preserve this path's original `run_id ASC` timeline ordering — run_id
      // and created_at can diverge under concurrent/live uploads, which would
      // otherwise shift flip_count and change whether flaky.detected fires.
      orderBy: "run_id",
    });

    if (candidates.length > 0) {
      const flakyTests = candidates
        .filter((t) => t.total_runs >= 3 && t.flip_count >= 2) // >= 2 flips to be considered flaky
        .map((t) => ({
          full_title: t.full_title,
          file_path: t.file_path,
          flaky_rate: t.flaky_rate,
          flip_count: t.flip_count,
          fail_count: t.fail_count,
          total_runs: t.total_runs,
        }))
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
