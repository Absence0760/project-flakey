export interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

let nextId = 0;
let listeners: Array<(toasts: Toast[]) => void> = [];
let toasts: Toast[] = [];

function notify() {
  for (const fn of listeners) fn(toasts);
}

export function addToast(message: string, type: Toast["type"] = "info", duration = 3000) {
  const id = nextId++;
  toasts = [...toasts, { id, message, type }];
  notify();
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function subscribe(fn: (toasts: Toast[]) => void) {
  listeners.push(fn);
  fn(toasts);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function toast(message: string) { addToast(message, "success"); }
export function toastError(message: string) { addToast(message, "error", 5000); }
export function toastInfo(message: string) { addToast(message, "info"); }
