import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
});

describe("toast", () => {
  it("addToast appends to the list and notifies subscribers", async () => {
    const { addToast, subscribe } = await import("./toast.js");
    const seen: string[] = [];
    const unsub = subscribe((toasts) => {
      seen.push(toasts.map((t) => t.message).join("|"));
    });

    addToast("first", "info", 0);
    addToast("second", "success", 0);

    expect(seen).toEqual(["", "first", "first|second"]);
    unsub();
  });

  it("dismissToast removes by id and notifies", async () => {
    const { addToast, dismissToast, subscribe } = await import("./toast.js");
    let last: { id: number; message: string }[] = [];
    subscribe((toasts) => {
      last = toasts.map((t) => ({ id: t.id, message: t.message }));
    });

    addToast("a", "info", 0);
    addToast("b", "info", 0);
    expect(last.map((t) => t.message)).toEqual(["a", "b"]);

    dismissToast(last[0].id);
    expect(last.map((t) => t.message)).toEqual(["b"]);
  });

  it("addToast with non-zero duration auto-dismisses on the timer", async () => {
    const { addToast, subscribe } = await import("./toast.js");
    let count = 0;
    subscribe((toasts) => { count = toasts.length; });

    addToast("ephemeral", "info", 1000);
    expect(count).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(count).toBe(0);
  });

  it("subscribe immediately fires with the current state and unsubscribe stops further notifications", async () => {
    const { addToast, subscribe } = await import("./toast.js");
    const calls: number[] = [];
    const unsub = subscribe((toasts) => calls.push(toasts.length));

    expect(calls).toEqual([0]);

    addToast("a", "info", 0);
    expect(calls).toEqual([0, 1]);

    unsub();
    addToast("b", "info", 0);
    expect(calls).toEqual([0, 1]);
  });

  it("toastError convenience uses the error type and a 5s duration", async () => {
    const { toastError, subscribe } = await import("./toast.js");
    let captured: { type: string; message: string }[] = [];
    subscribe((toasts) => {
      captured = toasts.map((t) => ({ type: t.type, message: t.message }));
    });

    toastError("boom");
    expect(captured).toEqual([{ type: "error", message: "boom" }]);

    vi.advanceTimersByTime(4999);
    expect(captured.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(captured.length).toBe(0);
  });
});
