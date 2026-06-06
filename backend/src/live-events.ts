import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import pool from "./db.js";
import type pg from "pg";

// Postgres channel for cross-task live fan-out. Every server process
// LISTENs here and re-emits remote notifications to its own SSE
// subscribers, so a reporter POSTing events to one ECS task reaches a
// dashboard client parked on a different task.
const LIVE_CHANNEL = "flakey_live";

export interface LiveTestEvent {
  type: "run.started" | "test.started" | "test.passed" | "test.failed" | "test.skipped" | "spec.started" | "spec.finished" | "run.finished" | "run.aborted";
  timestamp: number;
  runId: number;
  spec?: string;
  test?: string;
  status?: string;
  duration_ms?: number;
  error?: string;
  stats?: { total: number; passed: number; failed: number; skipped: number };
}

/**
 * Org-scoped delta emitted on GET /live/stream when a run enters or
 * leaves the active set. Replaces the dashboard's /live/active poll
 * (roadmap Phase 12) so the runs list reacts within milliseconds.
 */
export interface ActiveRunsDelta {
  type: "active.add" | "active.remove";
  runId: number;
}

interface RunMeta {
  orgId: number;
  lastEventAt: number;
}

class LiveEventBus {
  private emitters = new Map<number, EventEmitter>();
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private activeRuns = new Set<number>();
  private runMeta = new Map<number, RunMeta>();
  // Org-scoped emitters for active-set deltas. Created lazily on first
  // subscriber; kept idle (not deleted) when the last listener leaves
  // since EventEmitters with zero listeners are essentially free.
  private orgEmitters = new Map<number, EventEmitter>();

  // Cross-task fan-out state. `crossTask` stays false until startListener()
  // runs, so pure unit contexts (no DB) never broadcast. `instanceId` tags
  // our own NOTIFYs so we ignore them on the way back in (we already
  // delivered them locally). `listenClient` is a dedicated, never-released
  // pool connection that holds the LISTEN.
  private crossTask = false;
  private readonly instanceId = randomUUID();
  private listenClient: pg.PoolClient | null = null;

  /**
   * Begin cross-task fan-out: open a dedicated LISTEN connection and
   * re-emit remote notifications to local subscribers. Call once at
   * server startup. Idempotent. Until it runs, emit()/active deltas stay
   * process-local — which is exactly right for single-process unit tests.
   */
  startListener(): void {
    if (this.crossTask) return;
    this.crossTask = true;
    void this.connectListener();
  }

  private async connectListener(): Promise<void> {
    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();
      const c = client;
      c.on("notification", (msg) => {
        if (!msg.payload) return;
        try {
          this.applyRemote(JSON.parse(msg.payload));
        } catch {
          /* ignore malformed payloads */
        }
      });
      await c.query(`LISTEN ${LIVE_CHANNEL}`);
      // Only publish the client AFTER LISTEN succeeds. Assigning it earlier
      // would leak this connection if LISTEN throws: scheduleReconnect would
      // acquire a second client and overwrite the pointer, and the
      // reconnectListener guard (listenClient !== client) would never release
      // the first. A dropped backend connection surfaces as 'error'/'end';
      // reconnect so the listener self-heals.
      this.listenClient = c;
      c.on("error", () => this.reconnectListener(c));
      (c as unknown as EventEmitter).on("end", () => this.reconnectListener(c));
    } catch {
      // DB not ready yet, or a transient drop — destroy the half-open client
      // (if we got one) so it doesn't leak from the pool, then retry shortly.
      if (client) { try { client.release(true); } catch { /* already gone */ } }
      this.scheduleReconnect();
    }
  }

  private reconnectListener(client: pg.PoolClient): void {
    if (this.listenClient !== client) return; // already replaced
    this.listenClient = null;
    try { client.release(true); } catch { /* already gone */ }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const t = setTimeout(() => { void this.connectListener(); }, 2000);
    t.unref?.();
  }

  /**
   * Broadcast a payload to every task (including self — self is ignored on
   * receipt). No-ops until startListener() has enabled cross-task mode.
   */
  private broadcast(payload: Record<string, unknown>): void {
    if (!this.crossTask) return;
    let json = JSON.stringify({ o: this.instanceId, ...payload });
    if (json.length > 7500) {
      // pg_notify caps payloads near 8000 bytes. The event error message
      // is the only unbounded field — trim it so a huge failure stack
      // can't break cross-task delivery. The full error is still persisted
      // and served via the REST API.
      const ev = (payload as { event?: { error?: unknown } }).event;
      if (ev && ev.error !== undefined) {
        const trimmed = { ...payload, event: { ...ev, error: String(ev.error).slice(0, 2000) + "…[truncated]" } };
        json = JSON.stringify({ o: this.instanceId, ...trimmed });
      }
      if (json.length > 7900) return; // pathological single event — skip cross-task delivery
    }
    pool.query("SELECT pg_notify($1, $2)", [LIVE_CHANNEL, json]).catch(() => { /* best-effort */ });
  }

  /**
   * Apply a notification from ANOTHER task to local subscribers only — no
   * state mutation, no re-broadcast. The originating task owns the run's
   * active-set / staleness state; remote tasks just deliver to whichever
   * SSE clients they happen to be holding.
   */
  private applyRemote(payload: {
    o?: string;
    k?: string;
    runId?: number;
    orgId?: number;
    event?: LiveTestEvent;
    delta?: ActiveRunsDelta;
  }): void {
    if (payload.o === this.instanceId) return; // our own broadcast — already delivered locally
    if (payload.k === "event" && typeof payload.runId === "number" && payload.event) {
      this.emitters.get(payload.runId)?.emit("event", payload.event);
    } else if (payload.k === "active" && typeof payload.orgId === "number" && payload.delta) {
      this.orgEmitters.get(payload.orgId)?.emit("delta", payload.delta);
    }
  }

  /** Register a run with its org ID so stale detection can work. Call when run.started. */
  registerRun(runId: number, orgId: number): void {
    this.runMeta.set(runId, { orgId, lastEventAt: Date.now() });
  }

  /** Has this run been registered for stale detection? */
  hasRun(runId: number): boolean {
    return this.runMeta.has(runId);
  }

  /**
   * Forget every trace of a run from the in-memory state — emitters,
   * timeouts, activeRuns, runMeta. Call this when the run is deleted
   * from the DB so that:
   *   1. The stale-run timer doesn't try to abort a non-existent run
   *      (the `liveEvents.emit('run.aborted')` in abortRun would FK-
   *      fail on persistEvent because runs.id is gone, and the
   *      transitionPendingTestsAfterAbort UPDATE would no-op).
   *   2. /live/active doesn't keep listing the deleted run id.
   *   3. SSE listeners get a clean empty stream (any reconnect after
   *      delete sees `getEmitter` create a fresh one with no history).
   */
  unregister(runId: number): void {
    // removeActive() must fire BEFORE runMeta is cleared so the delta
    // can carry the correct orgId to /live/stream subscribers.
    this.removeActive(runId);
    const emitter = this.emitters.get(runId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(runId);
    }
    const timeout = this.timeouts.get(runId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(runId);
    }
    this.runMeta.delete(runId);
  }

  /**
   * Bump lastEventAt without emitting anything. Used by the events POST
   * handler so an empty-body heartbeat from a still-running reporter keeps
   * the run from tripping stale-run detection during long quiet periods
   * (single slow Cucumber scenario, big cy.wait(), etc.).
   */
  touch(runId: number): void {
    const meta = this.runMeta.get(runId);
    if (meta) meta.lastEventAt = Date.now();
  }

  /** Get or create an emitter for a run. Auto-cleans up after 30 minutes of inactivity. */
  getEmitter(runId: number): EventEmitter {
    let emitter = this.emitters.get(runId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(50);
      this.emitters.set(runId, emitter);
    }
    this.resetTimeout(runId);
    return emitter;
  }

  /** Emit an event for a run. */
  emit(runId: number, event: LiveTestEvent): void {
    // Track last activity for stale detection
    const meta = this.runMeta.get(runId);
    if (meta) meta.lastEventAt = Date.now();

    // Mark as active on first event, remove on run.finished / run.aborted
    if (event.type === "run.started") {
      this.addActive(runId);
    }

    const emitter = this.emitters.get(runId);
    if (!emitter) {
      // Auto-create emitter so events aren't lost if stream connects after first event
      const newEmitter = this.getEmitter(runId);
      this.addActive(runId);
      newEmitter.emit("event", event);
    } else {
      emitter.emit("event", event);
    }

    if (event.type === "run.finished" || event.type === "run.aborted") {
      this.removeActive(runId);
      // Clean up emitter shortly after finish (give subscribers time to get the event)
      setTimeout(() => {
        this.emitters.get(runId)?.removeAllListeners();
        this.emitters.delete(runId);
        const timeout = this.timeouts.get(runId);
        if (timeout) { clearTimeout(timeout); this.timeouts.delete(runId); }
        this.runMeta.delete(runId);
      }, 5000);
    }

    // Fan the event out to other tasks' SSE subscribers. Local delivery
    // already happened above; remote tasks deliver to their own listeners.
    this.broadcast({ k: "event", runId, event });
  }

  /** Check if anyone is listening for a run. */
  hasListeners(runId: number): boolean {
    const emitter = this.emitters.get(runId);
    return emitter ? emitter.listenerCount("event") > 0 : false;
  }

  /**
   * Get run IDs that are actively in-progress (between run.started and
   * run.finished).  When `orgId` is provided, scopes the result to runs
   * registered for that org — required by the public GET /live/active
   * endpoint to avoid leaking other orgs' active run ids.  Without
   * `orgId` (callers like getStaleRuns) returns the unscoped set.
   */
  getActiveRunIds(orgId?: number): number[] {
    if (orgId === undefined) return Array.from(this.activeRuns);
    const result: number[] = [];
    for (const runId of this.activeRuns) {
      if (this.runMeta.get(runId)?.orgId === orgId) result.push(runId);
    }
    return result;
  }

  /** Get active runs that have received no event for longer than maxInactivityMs. */
  getStaleRuns(maxInactivityMs: number): Array<{ runId: number; orgId: number }> {
    const now = Date.now();
    const result: Array<{ runId: number; orgId: number }> = [];
    for (const runId of this.activeRuns) {
      const meta = this.runMeta.get(runId);
      if (meta && now - meta.lastEventAt > maxInactivityMs) {
        result.push({ runId, orgId: meta.orgId });
      }
    }
    return result;
  }

  /**
   * Subscribe to active-set deltas for one org. Returns an unsubscribe
   * function. Used by the /live/stream SSE handler — the dashboard
   * subscribes once per session instead of polling /live/active every
   * 5 s (roadmap Phase 12).
   *
   * The org emitter is created lazily on first subscriber and kept
   * alive while listeners are attached; on disconnect we just `.off`
   * the listener. The idle emitter object stays in the map until the
   * process restarts — one EventEmitter per active org, trivial.
   */
  subscribeOrg(orgId: number, listener: (delta: ActiveRunsDelta) => void): () => void {
    let emitter = this.orgEmitters.get(orgId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(100);
      this.orgEmitters.set(orgId, emitter);
    }
    emitter.on("delta", listener);
    return () => emitter!.off("delta", listener);
  }

  /**
   * Add a run to the active set and notify the org subscribers.
   * Idempotent — a duplicate run.started won't re-emit. Skips the
   * notification if runMeta is missing (no orgId known) — that only
   * happens via the auto-create-emitter path for an event without a
   * preceding registerRun, which is itself unusual.
   */
  private addActive(runId: number): void {
    if (this.activeRuns.has(runId)) return;
    this.activeRuns.add(runId);
    const orgId = this.runMeta.get(runId)?.orgId;
    if (orgId !== undefined) {
      const delta: ActiveRunsDelta = { type: "active.add", runId };
      this.orgEmitters.get(orgId)?.emit("delta", delta);
      this.broadcast({ k: "active", orgId, delta });
    }
  }

  /** Remove a run from the active set and notify the org subscribers. */
  private removeActive(runId: number): void {
    if (!this.activeRuns.has(runId)) return;
    this.activeRuns.delete(runId);
    const orgId = this.runMeta.get(runId)?.orgId;
    if (orgId !== undefined) {
      const delta: ActiveRunsDelta = { type: "active.remove", runId };
      this.orgEmitters.get(orgId)?.emit("delta", delta);
      this.broadcast({ k: "active", orgId, delta });
    }
  }

  private resetTimeout(runId: number): void {
    const existing = this.timeouts.get(runId);
    if (existing) clearTimeout(existing);
    this.timeouts.set(runId, setTimeout(() => {
      // removeActive() must fire BEFORE runMeta is cleared so the
      // delta can carry the correct orgId to /live/stream subscribers.
      this.removeActive(runId);
      this.emitters.get(runId)?.removeAllListeners();
      this.emitters.delete(runId);
      this.timeouts.delete(runId);
      this.runMeta.delete(runId);
    }, 30 * 60 * 1000)); // 30 minutes
  }
}

export const liveEvents = new LiveEventBus();
