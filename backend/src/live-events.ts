import { EventEmitter } from "events";

export interface LiveTestEvent {
  type: "run.started" | "test.started" | "test.passed" | "test.failed" | "test.skipped" | "spec.started" | "spec.finished" | "run.finished";
  timestamp: number;
  runId: number;
  spec?: string;
  test?: string;
  status?: string;
  duration_ms?: number;
  error?: string;
  stats?: { total: number; passed: number; failed: number; skipped: number };
}

class LiveEventBus {
  private emitters = new Map<number, EventEmitter>();
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private activeRuns = new Set<number>();

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
    // Mark as active on first event, remove on run.finished
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

    if (event.type === "run.finished") {
      this.activeRuns.delete(runId);
      // Clean up emitter shortly after finish (give subscribers time to get the event)
      setTimeout(() => {
        this.emitters.get(runId)?.removeAllListeners();
        this.emitters.delete(runId);
        const timeout = this.timeouts.get(runId);
        if (timeout) { clearTimeout(timeout); this.timeouts.delete(runId); }
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

  private resetTimeout(runId: number): void {
    const existing = this.timeouts.get(runId);
    if (existing) clearTimeout(existing);
    this.timeouts.set(runId, setTimeout(() => {
      this.emitters.get(runId)?.removeAllListeners();
      this.emitters.delete(runId);
      this.timeouts.delete(runId);
      this.activeRuns.delete(runId);
    }, 30 * 60 * 1000)); // 30 minutes
  }
}

export const liveEvents = new LiveEventBus();
