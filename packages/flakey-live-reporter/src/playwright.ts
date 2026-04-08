/**
 * Playwright live reporter — add as a secondary reporter alongside the main Flakey reporter.
 *
 * Usage in playwright.config.ts:
 *   reporter: [
 *     ['@flakeytesting/playwright-reporter', { url, apiKey, suite }],
 *     ['@flakeytesting/live-reporter/playwright', { url, apiKey, runId }],
 *   ]
 *
 * Note: runId must be known ahead of time (e.g. from a prior upload or the CI run ID).
 * Alternatively, set FLAKEY_LIVE_RUN_ID env var.
 */

import { LiveClient, type LiveReporterOptions } from "./index.js";

interface PlaywrightReporterConfig {
  url?: string;
  apiKey?: string;
  runId?: number;
}

export default class PlaywrightLiveReporter {
  private client: LiveClient | null = null;

  constructor(config: PlaywrightReporterConfig = {}) {
    const url = config.url ?? process.env.FLAKEY_API_URL;
    const apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY;
    const runId = config.runId ?? Number(process.env.FLAKEY_LIVE_RUN_ID);

    if (!url || !apiKey || !runId) return;

    this.client = new LiveClient({ url, apiKey, runId });
  }

  onBegin(config: unknown, suite: { allTests: () => Array<unknown> }) {
    this.client?.send({
      type: "run.started",
      stats: { total: suite.allTests().length, passed: 0, failed: 0, skipped: 0 },
    });
  }

  onTestBegin(test: { title: string; parent?: { title?: string; location?: { file: string } } }) {
    this.client?.send({
      type: "test.started",
      test: test.title,
      spec: test.parent?.location?.file,
    });
  }

  onTestEnd(test: { title: string; parent?: { location?: { file: string } } },
            result: { status: string; duration: number; error?: { message?: string } }) {
    const type = result.status === "passed" ? "test.passed"
      : result.status === "failed" || result.status === "timedOut" ? "test.failed"
      : "test.skipped";

    this.client?.send({
      type,
      test: test.title,
      spec: test.parent?.location?.file,
      status: result.status,
      duration_ms: result.duration,
      error: result.error?.message,
    });
  }

  async onEnd(result: { status: string }) {
    this.client?.send({ type: "run.finished", status: result.status });
    await this.client?.flush();
  }
}
