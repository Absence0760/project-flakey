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
    const emitter = this.emitters.get(runId);
    if (emitter) {
      emitter.emit("event", event);
    }
  }

  /** Check if anyone is listening for a run. */
  hasListeners(runId: number): boolean {
    const emitter = this.emitters.get(runId);
    return emitter ? emitter.listenerCount("event") > 0 : false;
  }

  private resetTimeout(runId: number): void {
    const existing = this.timeouts.get(runId);
    if (existing) clearTimeout(existing);
    this.timeouts.set(runId, setTimeout(() => {
      this.emitters.get(runId)?.removeAllListeners();
      this.emitters.delete(runId);
      this.timeouts.delete(runId);
    }, 30 * 60 * 1000)); // 30 minutes
  }
}

export const liveEvents = new LiveEventBus();
