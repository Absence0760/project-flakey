import { EventEmitter } from "events";

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
      this.orgEmitters.get(orgId)?.emit("delta", { type: "active.add", runId });
    }
  }

  /** Remove a run from the active set and notify the org subscribers. */
  private removeActive(runId: number): void {
    if (!this.activeRuns.has(runId)) return;
    this.activeRuns.delete(runId);
    const orgId = this.runMeta.get(runId)?.orgId;
    if (orgId !== undefined) {
      this.orgEmitters.get(orgId)?.emit("delta", { type: "active.remove", runId });
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
