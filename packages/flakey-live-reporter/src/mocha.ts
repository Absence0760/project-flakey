/**
 * Mocha/Cypress live reporter — streams test events during execution.
 *
 * Usage with Cypress:
 *   // cypress.config.ts
 *   setupNodeEvents(on) {
 *     require('@flakeytesting/live-reporter/mocha').register(on, {
 *       url: 'http://localhost:3000',
 *       apiKey: 'fk_...',
 *       suite: 'my-suite',
 *     });
 *   }
 *
 * The reporter automatically creates a placeholder run via POST /live/start
 * so the run appears in the dashboard immediately. The main reporter's upload
 * at the end merges into this run via ci_run_id.
 *
 * Env vars: FLAKEY_API_URL, FLAKEY_API_KEY, FLAKEY_LIVE_RUN_ID (optional override)
 */

import { LiveClient, installShutdownHandler } from "./index.js";

interface MochaLiveConfig {
  url?: string;
  apiKey?: string;
  suite?: string;
  runId?: number;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
}

export function register(
  on: (event: string, handler: (...args: any[]) => void) => void,
  config: MochaLiveConfig = {}
) {
  const url = (config.url ?? process.env.FLAKEY_API_URL ?? "").replace(/\/$/, "");
  const apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY ?? "";
  const suite = config.suite ?? process.env.FLAKEY_SUITE ?? "";

  if (!url || !apiKey) return;

  // Make credentials visible to sibling plugins (e.g. cypress-snapshots streaming).
  process.env.FLAKEY_API_URL = url;
  process.env.FLAKEY_API_KEY = apiKey;

  let client: LiveClient | null = null;
  let teardownShutdown: (() => void) | null = null;
  let runId = config.runId ?? (Number(process.env.FLAKEY_LIVE_RUN_ID) || 0);

  on("before:run", async () => {
    // If no runId, create a placeholder run via /live/start
    if (!runId && suite) {
      try {
        const res = await fetch(`${url}/live/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            suite,
            branch: config.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "",
            commitSha: config.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
            ciRunId: config.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
          }),
        });
        if (res.ok) {
          const data = await res.json() as { id: number; ci_run_id: string };
          runId = data.id;
          // Set CI_RUN_ID so the main reporter merges into this run
          if (data.ci_run_id) {
            process.env.CI_RUN_ID = data.ci_run_id;
          }
          // Expose the numeric run id so other plugins (e.g. cypress-snapshots) can stream artifacts mid-run.
          process.env.FLAKEY_LIVE_RUN_ID = String(runId);
          console.log(`[flakey-live] Live run started: #${runId} (ci_run_id: ${data.ci_run_id})`);
        }
      } catch (err) {
        console.error("[flakey-live] Failed to start live run:", err);
      }
    }

    if (!runId) return;

    client = new LiveClient({ url, apiKey, runId });
    client.send({ type: "run.started" });
    // Ctrl-C / SIGTERM before after:run fires → tell the backend immediately
    // so the LIVE badge clears instead of waiting for the stale timeout.
    teardownShutdown = installShutdownHandler(client, {
      reason: "Cypress process received a shutdown signal.",
    });
  });

  on("before:spec", (spec: { relative: string }) => {
    client?.send({ type: "spec.started", spec: spec.relative });
  });

  on("after:spec", (spec: { relative: string }, results: { stats: { passes: number; failures: number; skipped: number; tests: number } }) => {
    // Individual test.passed/failed/skipped events are sent in real-time by the
    // Flakey Cypress reporter (reporter.ts) as each test finishes. Here we only
    // emit the spec-level summary so the live feed shows spec completion markers.
    client?.send({
      type: "spec.finished",
      spec: spec.relative,
      stats: {
        total: results.stats.tests,
        passed: results.stats.passes,
        failed: results.stats.failures,
        skipped: results.stats.skipped,
      },
    });
  });

  on("after:run", async (results: { totalFailed?: number; totalPassed?: number; totalTests?: number } | undefined) => {
    client?.send({ type: "run.finished" });
    await client?.flush();
    // Normal exit path — release the signal handlers so an unrelated SIGTERM
    // later in the process lifecycle doesn't spuriously abort a finished run.
    teardownShutdown?.();
    teardownShutdown = null;
    if (runId) {
      const failed = results?.totalFailed ?? 0;
      const passed = results?.totalPassed ?? 0;
      const total = results?.totalTests ?? 0;
      const status = failed > 0 ? `${failed} failed, ${passed} passed` : `${total} passed`;
      console.log(`[flakey-live] Run #${runId} complete — ${status}`);
    }
  });
}
