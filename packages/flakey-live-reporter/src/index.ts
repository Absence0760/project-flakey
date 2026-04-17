/**
 * Core live event client. Framework-specific reporters use this to send events.
 */

export interface LiveEvent {
  type: "run.started" | "test.started" | "test.passed" | "test.failed" | "test.skipped" | "spec.started" | "spec.finished" | "run.finished" | "run.aborted";
  timestamp?: number;
  spec?: string;
  test?: string;
  status?: string;
  duration_ms?: number;
  error?: string;
  stats?: { total: number; passed: number; failed: number; skipped: number };
}

export interface LiveReporterOptions {
  url: string;
  apiKey: string;
  runId: number;
}

export class LiveClient {
  private url: string;
  private apiKey: string;
  private runId: number;
  private queue: LiveEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveReporterOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.runId = options.runId;
  }

  /** Queue an event for sending. Events are batched and flushed every 500ms. */
  send(event: LiveEvent): void {
    this.queue.push({ ...event, timestamp: event.timestamp ?? Date.now() });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 500);
    }
  }

  /** Flush all queued events immediately. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) return;

    const events = this.queue.splice(0);
    try {
      await fetch(`${this.url}/live/${this.runId}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(events),
      });
    } catch {
      // Silently drop — live events are best-effort
    }
  }

  /** Fire-and-forget abort notification — used by signal handlers. */
  abort(reason?: string): void {
    try {
      fetch(`${this.url}/live/${this.runId}/abort`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ reason }),
        keepalive: true,
      } as RequestInit).catch(() => {});
    } catch {
      /* swallow — best-effort from a signal handler */
    }
  }
}

/**
 * Wire SIGINT / SIGTERM / exit handlers so a Ctrl-C or kill triggers an
 * immediate abort notification to the backend. Without this the UI has to
 * wait for the backend's stale-run timeout (default 10 minutes) to clear the
 * LIVE badge.
 *
 * Returns a teardown function the caller can invoke on graceful completion
 * (e.g. from `after:run`) so a normal `run.finished` doesn't race into an abort.
 */
export function installShutdownHandler(
  client: LiveClient,
  opts: { reason?: string } = {}
): () => void {
  let fired = false;
  const abort = () => {
    if (fired) return;
    fired = true;
    client.abort(opts.reason ?? "Test process received a shutdown signal.");
  };

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  process.once("exit", abort);

  return () => {
    fired = true; // prevent any subsequent signal from firing abort
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    process.off("exit", abort);
  };
}
