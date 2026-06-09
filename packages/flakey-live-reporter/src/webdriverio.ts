/**
 * WebdriverIO live reporter — streams test events during execution.
 *
 * Usage in wdio.conf.ts:
 *   reporters: [
 *     ['@flakeytesting/webdriverio-reporter', { url, apiKey, suite }],
 *     ['@flakeytesting/live-reporter/webdriverio', { url, apiKey, suite }],
 *   ]
 *
 * Automatically creates a placeholder run via /live/start and sets CI_RUN_ID
 * so the main reporter's upload merges into it.
 */

import { LiveClient, installShutdownHandler } from "./index.js";

interface WdioLiveConfig {
  url?: string;
  apiKey?: string;
  suite?: string;
  runId?: number;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
  /**
   * Target environment label (e.g. "qa", "stage", "prod"). Falls back
   * to FLAKEY_ENV / TEST_ENV process env vars when omitted.
   */
  environment?: string;
  /**
   * When true, prints `[flakey-live] Live run started: #N` and
   * `[flakey-live] Run #N complete` to stdout. Default false — keeps
   * CI logs quiet; errors still print. `FLAKEY_VERBOSE=1` env honoured.
   */
  verbose?: boolean;
}

export default class WebdriverIOLiveReporter {
  private client: LiveClient | null = null;
  private teardownShutdown: (() => void) | null = null;
  private url: string;
  private apiKey: string;
  private suite: string;
  private config: WdioLiveConfig;
  private runId: number;
  private verbose: boolean;

  constructor(config: WdioLiveConfig = {}) {
    this.url = (config.url ?? process.env.FLAKEY_API_URL ?? "").replace(/\/$/, "");
    this.apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY ?? "";
    this.suite = config.suite ?? process.env.FLAKEY_SUITE ?? "";
    this.config = config;
    this.runId = config.runId ?? (Number(process.env.FLAKEY_LIVE_RUN_ID) || 0);
    this.verbose = config.verbose === true || process.env.FLAKEY_VERBOSE === "1";
  }

  async onRunnerStart() {
    if (!this.url || !this.apiKey) return;

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
            environment: this.config.environment ?? process.env.FLAKEY_ENV ?? process.env.TEST_ENV ?? "",
          }),
        });
        if (res.ok) {
          const data = await res.json() as { id?: unknown; ci_run_id?: unknown };
          // Validate the run id is a finite positive integer before it flows
          // into LiveClient's URL building. A non-numeric id is truthy, so the
          // `if (!this.runId)` check below wouldn't catch it — it would build
          // `/live/<garbage>/events`, 404 on every event, and silently drop
          // the entire live feed. Mirrors the mocha adapter's guard.
          if (typeof data.id !== "number" || !Number.isFinite(data.id) || data.id <= 0) {
            if (this.verbose) {
              console.warn("[flakey-live] /live/start returned a non-numeric id; skipping live stream");
            }
            return;
          }
          this.runId = data.id;
          if (typeof data.ci_run_id === "string") {
            process.env.CI_RUN_ID = data.ci_run_id;
          }
          if (this.verbose) {
            console.log(`[flakey-live] Live run started: #${this.runId}`);
          }
        }
      } catch (err) {
        console.error("[flakey-live] Failed to start live run:", err);
      }
    }

    if (!this.runId) return;

    this.client = new LiveClient({ url: this.url, apiKey: this.apiKey, runId: this.runId });
    this.client.send({ type: "run.started" });
    this.teardownShutdown = installShutdownHandler(this.client, {
      reason: "WebdriverIO process received a shutdown signal.",
    });
  }

  onSuiteStart(suite: { file?: string; title?: string }) {
    this.client?.send({ type: "spec.started", spec: suite.file ?? suite.title });
  }

  onTestPass(test: { title: string; parent?: string; duration?: number; file?: string }) {
    this.client?.send({
      type: "test.passed",
      test: test.title,
      spec: test.file ?? test.parent,
      status: "passed",
      duration_ms: test.duration,
    });
  }

  onTestFail(test: { title: string; parent?: string; duration?: number; file?: string; error?: { message?: string } }) {
    this.client?.send({
      type: "test.failed",
      test: test.title,
      spec: test.file ?? test.parent,
      status: "failed",
      duration_ms: test.duration,
      error: test.error?.message,
    });
  }

  onTestSkip(test: { title: string; parent?: string; file?: string }) {
    this.client?.send({
      type: "test.skipped",
      test: test.title,
      spec: test.file ?? test.parent,
      status: "skipped",
    });
  }

  async onRunnerEnd() {
    this.client?.send({ type: "run.finished" });
    await this.client?.flush();
    this.client?.stop();
    this.teardownShutdown?.();
    this.teardownShutdown = null;
    if (this.runId && this.verbose) {
      console.log(`[flakey-live] Run #${this.runId} complete`);
    }
  }
}
