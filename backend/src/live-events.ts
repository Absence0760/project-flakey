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

interface RunMeta {
  orgId: number;
  lastEventAt: number;
}

class LiveEventBus {
  private emitters = new Map<number, EventEmitter>();
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private activeRuns = new Set<number>();
  private runMeta = new Map<number, RunMeta>();

  /** Register a run with its org ID so stale detection can work. Call when run.started. */
  registerRun(runId: number, orgId: number): void {
    this.runMeta.set(runId, { orgId, lastEventAt: Date.now() });
  }

  /** Has this run been registered for stale detection? */
  hasRun(runId: number): boolean {
    return this.runMeta.has(runId);
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
      this.activeRuns.add(runId);
    }

    const emitter = this.emitters.get(runId);
    if (!emitter) {
      // Auto-create emitter so events aren't lost if stream connects after first event
      const newEmitter = this.getEmitter(runId);
      this.activeRuns.add(runId);
      newEmitter.emit("event", event);
    } else {
      emitter.emit("event", event);
    }

    if (event.type === "run.finished" || event.type === "run.aborted") {
      this.activeRuns.delete(runId);
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

  /** Get all run IDs that are actively in-progress (between run.started and run.finished). */
  getActiveRunIds(): number[] {
    return Array.from(this.activeRuns);
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

  private resetTimeout(runId: number): void {
    const existing = this.timeouts.get(runId);
    if (existing) clearTimeout(existing);
    this.timeouts.set(runId, setTimeout(() => {
      this.emitters.get(runId)?.removeAllListeners();
      this.emitters.delete(runId);
      this.timeouts.delete(runId);
      this.activeRuns.delete(runId);
      this.runMeta.delete(runId);
    }, 30 * 60 * 1000)); // 30 minutes
  }
}

export const liveEvents = new LiveEventBus();
