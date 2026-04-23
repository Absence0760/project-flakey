/**
 * Playwright live reporter — add as a secondary reporter alongside the main Flakey reporter.
 *
 * Usage in playwright.config.ts:
 *   reporter: [
 *     ['@flakeytesting/playwright-reporter', { url, apiKey, suite }],
 *     ['@flakeytesting/live-reporter/playwright', { url, apiKey, suite }],
 *   ]
 *
 * Automatically creates a placeholder run via /live/start and sets CI_RUN_ID
 * so the main reporter's upload merges into it.
 */

import { LiveClient, installShutdownHandler } from "./index.js";

interface PlaywrightReporterConfig {
  url?: string;
  apiKey?: string;
  suite?: string;
  runId?: number;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
}

export default class PlaywrightLiveReporter {
  private client: LiveClient | null = null;
  private teardownShutdown: (() => void) | null = null;
  private url: string;
  private apiKey: string;
  private suite: string;
  private config: PlaywrightReporterConfig;
  private runId: number;

  constructor(config: PlaywrightReporterConfig = {}) {
    this.url = (config.url ?? process.env.FLAKEY_API_URL ?? "").replace(/\/$/, "");
    this.apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY ?? "";
    this.suite = config.suite ?? process.env.FLAKEY_SUITE ?? "";
    this.config = config;
    this.runId = config.runId ?? (Number(process.env.FLAKEY_LIVE_RUN_ID) || 0);
  }

  async onBegin(_config: unknown, suite: { allTests: () => Array<unknown> }) {
    if (!this.url || !this.apiKey) return;

    // Create a placeholder run if no runId provided
    if (!this.runId && this.suite) {
      try {
        const res = await fetch(`${this.url}/live/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            suite: this.suite,
            branch: this.config.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
            commitSha: this.config.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
            ciRunId: this.config.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
          }),
        });
        if (res.ok) {
          const data = await res.json() as { id: number; ci_run_id: string };
          this.runId = data.id;
          if (data.ci_run_id) {
            process.env.CI_RUN_ID = data.ci_run_id;
          }
          console.log(`[flakey-live] Live run started: #${this.runId} (ci_run_id: ${data.ci_run_id})`);
        }
      } catch (err) {
        console.error("[flakey-live] Failed to start live run:", err);
      }
    }

    if (!this.runId) return;

    this.client = new LiveClient({ url: this.url, apiKey: this.apiKey, runId: this.runId });
    this.client.send({
      type: "run.started",
      stats: { total: suite.allTests().length, passed: 0, failed: 0, skipped: 0 },
    });
    this.teardownShutdown = installShutdownHandler(this.client, {
      reason: "Playwright process received a shutdown signal.",
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
    this.teardownShutdown?.();
    this.teardownShutdown = null;
    if (this.runId) {
      console.log(`[flakey-live] Run #${this.runId} complete`);
    }
  }
}
