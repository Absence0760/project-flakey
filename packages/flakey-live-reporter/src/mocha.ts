/**
 * Mocha/Cypress live reporter — streams test events during execution.
 *
 * Usage with Cypress:
 *   // cypress.config.ts
 *   setupNodeEvents(on) {
 *     require('@flakeytesting/live-reporter/mocha').register(on, {
 *       url: 'http://localhost:3000',
 *       apiKey: 'fk_...',
 *       runId: 123,
 *     });
 *   }
 *
 * Or set env vars: FLAKEY_API_URL, FLAKEY_API_KEY, FLAKEY_LIVE_RUN_ID
 */

import { LiveClient } from "./index.js";

interface MochaLiveConfig {
  url?: string;
  apiKey?: string;
  runId?: number;
}

export function register(
  on: (event: string, handler: (...args: any[]) => void) => void,
  config: MochaLiveConfig = {}
) {
  const url = config.url ?? process.env.FLAKEY_API_URL;
  const apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY;
  const runId = config.runId ?? Number(process.env.FLAKEY_LIVE_RUN_ID);

  if (!url || !apiKey || !runId) return;

  const client = new LiveClient({ url, apiKey, runId });

  on("before:run", () => {
    client.send({ type: "run.started" });
  });

  on("before:spec", (spec: { relative: string }) => {
    client.send({ type: "spec.started", spec: spec.relative });
  });

  on("after:spec", (spec: { relative: string }, results: { stats: { passes: number; failures: number; skipped: number; tests: number } }) => {
    client.send({
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

  on("after:run", async () => {
    client.send({ type: "run.finished" });
    await client.flush();
  });
}
