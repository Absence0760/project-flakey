/**
 * Cypress support file for command-log + failure-context capture.
 * Import in cypress/support/e2e.ts:
 *   import "@flakeytesting/cypress-reporter/support";
 */

interface CommandEntry {
  name: string;
  message: string;
  state: string;
}

let currentCommands: CommandEntry[] = [];

const skip = new Set(["xhr", "request", "route", "new url", "page load", "task"]);

// Buffer commands as they're logged
Cypress.on("log:added" as any, (log: any) => {
  const name = log.name;
  if (!name || skip.has(name)) return;

  currentCommands.push({
    name,
    message: log.message ?? "",
    state: log.state ?? "passed",
  });
});

// Update command state when it changes (e.g. assertion fails)
Cypress.on("log:changed" as any, (log: any) => {
  const name = log.name;
  if (!name || skip.has(name)) return;

  // Find the last command with this name and update its state
  for (let i = currentCommands.length - 1; i >= 0; i--) {
    if (currentCommands[i].name === name && currentCommands[i].message === (log.message ?? "")) {
      currentCommands[i].state = log.state ?? currentCommands[i].state;
      break;
    }
  }
});

// ---- Failure-context capture (Phase 13) ----
//
// What a Cypress red actually needs to diagnose it: browser console output,
// uncaught exceptions / unhandled rejections, and failed network requests at
// failure time. These live on the *application* window (a different realm
// from the Cypress spec), so they're hooked via `window:before:load` and
// drained per test. The Cypress counterpart to Playwright's trace capture.

const MAX_CONSOLE_LINES = 100;
const MAX_NETWORK_LINES = 50;
const MAX_COMMANDS_TAIL = 50;

let consoleBuffer: string[] = [];
let networkBuffer: string[] = [];
let uncaughtBuffer: string[] = [];
// Per-attempt error trail, keyed by leaf test title (matches how command logs
// are keyed). Accumulates across retries so the pass/fail delta is available;
// non-final attempts stay uncounted by the reporter — this only retains errors.
const retryErrorsByTitle = new Map<string, { attempt: number; message: string; stack?: string }[]>();

function fmtArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function pushCapped(buf: string[], line: string, cap: number): void {
  buf.push(line);
  if (buf.length > cap) buf.shift();
}

// Record uncaught exceptions + unhandled rejections WITHOUT returning false —
// returning false would suppress Cypress's default fail-the-test behavior, and
// we must never change pass/fail. We only observe.
Cypress.on("uncaught:exception" as any, (err: Error) => {
  pushCapped(uncaughtBuffer, err.stack ?? err.message ?? String(err), MAX_CONSOLE_LINES);
  // Intentionally return nothing — preserve Cypress's default (test fails).
});

// Hook the application window each time it loads: console + network.
Cypress.on("window:before:load" as any, (win: any) => {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = win.console?.[level];
    if (typeof orig !== "function") continue;
    win.console[level] = (...args: unknown[]) => {
      pushCapped(consoleBuffer, `${level}: ${args.map(fmtArg).join(" ")}`, MAX_CONSOLE_LINES);
      return orig.apply(win.console, args);
    };
  }

  const origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (this: unknown, ...args: any[]) {
      const req = args[0];
      const method = (args[1]?.method ?? (req && req.method) ?? "GET").toUpperCase();
      const url = typeof req === "string" ? req : (req?.url ?? "");
      return origFetch.apply(this, args).then(
        (res: any) => {
          if (res && !res.ok) pushCapped(networkBuffer, `${method} ${url} → ${res.status}`, MAX_NETWORK_LINES);
          return res;
        },
        (err: any) => {
          pushCapped(networkBuffer, `${method} ${url} → network error: ${err?.message ?? err}`, MAX_NETWORK_LINES);
          throw err;
        }
      );
    };
  }

  const XHR = win.XMLHttpRequest;
  if (typeof XHR === "function") {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: any, method: string, url: string, ...rest: any[]) {
      this.__flakeyMethod = (method ?? "GET").toUpperCase();
      this.__flakeyUrl = url ?? "";
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: any, ...rest: any[]) {
      this.addEventListener("loadend", () => {
        if (this.status === 0) {
          pushCapped(networkBuffer, `${this.__flakeyMethod} ${this.__flakeyUrl} → network error`, MAX_NETWORK_LINES);
        } else if (this.status >= 400) {
          pushCapped(networkBuffer, `${this.__flakeyMethod} ${this.__flakeyUrl} → ${this.status}`, MAX_NETWORK_LINES);
        }
      });
      return origSend.apply(this, rest);
    };
  }
});

// Reset before each test (per-attempt buffers; retry trail persists by title)
beforeEach(() => {
  currentCommands = [];
  consoleBuffer = [];
  networkBuffer = [];
  uncaughtBuffer = [];
});

// Save command log + failure context after each test
afterEach(() => {
  const cy_ = Cypress as any;
  const testTitle = cy_.currentTest?.title ?? "unknown";
  const specFile = cy_.spec?.relative ?? Cypress.spec?.name ?? "unknown";
  const failed = (cy_.currentTest?.state ?? cy_.state?.("runnable")?.state) === "failed";

  // Update the last command's state if the test failed
  if (failed && currentCommands.length > 0) {
    currentCommands[currentCommands.length - 1].state = "failed";
  }

  if (currentCommands.length > 0) {
    cy.task("flakey:saveCommandLog", {
      testTitle,
      specFile,
      commands: [...currentCommands],
    }, { log: false });
  }

  // Accumulate this attempt's error onto the per-title retry trail so a
  // retried-then-passing test still carries every attempt's error.
  if (failed) {
    const err = cy_.state?.("runnable")?.err ?? cy_.currentTest?.err;
    const trail = retryErrorsByTitle.get(testTitle) ?? [];
    trail.push({
      attempt: trail.length,
      message: err?.message ?? "unknown error",
      stack: err?.stack,
    });
    retryErrorsByTitle.set(testTitle, trail);
  }

  const retryTrail = retryErrorsByTitle.get(testTitle) ?? [];
  const hasContext =
    failed || consoleBuffer.length > 0 || networkBuffer.length > 0 ||
    uncaughtBuffer.length > 0 || retryTrail.length > 0;

  if (!hasContext) return;

  const failureContext: Record<string, unknown> = {};
  if (currentCommands.length > 0) {
    failureContext.commands_tail = currentCommands.slice(-MAX_COMMANDS_TAIL);
  }
  if (consoleBuffer.length > 0) failureContext.browser_console = [...consoleBuffer];
  if (uncaughtBuffer.length > 0) failureContext.uncaught_errors = [...uncaughtBuffer];
  if (networkBuffer.length > 0) failureContext.network_failures = [...networkBuffer];
  if (retryTrail.length > 0) failureContext.retry_errors = [...retryTrail];

  cy.task("flakey:saveFailureContext", {
    testTitle,
    specFile,
    failureContext,
  }, { log: false });
});
