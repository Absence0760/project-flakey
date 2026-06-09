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
  /**
   * Interval at which the client pings the backend with an empty-body POST
   * to keep stale-run detection happy during long quiet periods (single slow
   * Cucumber scenario, large cy.wait, etc.). Defaults to 30s. Set to 0 to
   * disable.
   */
  heartbeatIntervalMs?: number;
}

/**
 * Cap on events retained while the backend is unreachable, so a sustained
 * outage can't grow the queue without bound. Oldest events are dropped first.
 */
const MAX_QUEUE = 1000;
/** Abort a flush that hangs so a stuck backend can't stall the test run. */
const FLUSH_TIMEOUT_MS = 10_000;

export class LiveClient {
  private url: string;
  private apiKey: string;
  private runId: number;
  private queue: LiveEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LiveReporterOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.runId = options.runId;

    const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        // POST an empty array — the backend treats every events request as
        // activity, so this resets the stale-run timer without emitting
        // anything to listeners.
        this.flush({ allowEmpty: true }).catch(() => {});
      }, heartbeatMs);
      // Don't keep the process alive just for heartbeats.
      if (typeof (this.heartbeatTimer as { unref?: () => void }).unref === "function") {
        (this.heartbeatTimer as { unref: () => void }).unref();
      }
    }
  }

  /** Queue an event for sending. Events are batched and flushed every 500ms. */
  send(event: LiveEvent): void {
    this.queue.push({ ...event, timestamp: event.timestamp ?? Date.now() });
    if (!this.flushTimer) {
      // Match the retry timer below: swallow rejections and unref so a pending
      // auto-flush never holds the process open past end-of-run. The adapters
      // explicitly flush in their end hooks, but an abnormal exit between send
      // and that flush shouldn't keep the process alive for up to 500ms.
      this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 500);
      if (typeof (this.flushTimer as { unref?: () => void }).unref === "function") {
        (this.flushTimer as { unref: () => void }).unref();
      }
    }
  }

  /**
   * Flush all queued events immediately. Pass `{ allowEmpty: true }` to send
   * an empty-body heartbeat when the queue is empty.
   */
  async flush(opts: { allowEmpty?: boolean } = {}): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0 && !opts.allowEmpty) return;

    const events = this.queue.splice(0);
    let delivered = false;
    try {
      const res = await fetch(`${this.url}/live/${this.runId}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });
      delivered = res.ok;
    } catch {
      // Network error or timeout — fall through and retain the batch.
    }

    // Live events are best-effort, but a transient blip (5xx / dropped
    // connection) shouldn't lose a whole window of state when the next flush
    // would land. Re-queue the failed batch ahead of anything that arrived
    // mid-flight (preserving chronological order), bound memory by dropping the
    // oldest beyond MAX_QUEUE, and schedule a retry. An empty heartbeat batch
    // has nothing to retain, so it stays fire-and-forget.
    if (!delivered && events.length > 0) {
      this.queue.unshift(...events);
      if (this.queue.length > MAX_QUEUE) {
        this.queue.splice(0, this.queue.length - MAX_QUEUE);
      }
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 500);
        // Don't let retries against a down backend keep the process alive past
        // end-of-run — best-effort means we give up when nothing else runs.
        if (typeof (this.flushTimer as { unref?: () => void }).unref === "function") {
          (this.flushTimer as { unref: () => void }).unref();
        }
      }
    }
  }

  /** Stop the heartbeat timer and any pending retry. Idempotent. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
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
