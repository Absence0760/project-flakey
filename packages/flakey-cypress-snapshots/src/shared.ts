import { gherkinMarkerMessage } from "./cucumber-format.js";

export interface ConsoleEntry {
  /** Normalized level: log | info | warn | error | debug. */
  level: string;
  text: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
}

export interface SnapshotStep {
  index: number;
  commandName: string;
  commandMessage: string;
  timestamp: number;
  html: string;
  scrollX: number;
  scrollY: number;
  // Phase 3 per-step enrichment: console + network captured DURING the command
  // this step represents. Optional — absent when nothing was observed — so the
  // bundle stays backward-compatible with the frontend (which renders them only
  // when present) and with pre-enrichment consumers.
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
}

export const state: {
  steps: SnapshotStep[];
  commandIndex: number;
  testStartTime: number;
  /** Number of per-step cap trips in the current test. */
  cappedCount: number;
  /**
   * Number of steps evicted in the current test — by EITHER the step-count
   * ring buffer (MAX_STEPS) or the aggregate-byte cap. Both are real losses
   * the operator should see in the end-of-test summary / `evictedSteps` field.
   */
  evictedCount: number;
  /** Running total of `html.length` across steps. Kept in sync by pushStep. */
  bundleBytes: number;
  /** Id of the Gherkin step we last emitted a marker for (dedup, per test). */
  lastGherkinStepId: string | undefined;
  /**
   * Console / network captured since the last step was pushed. Flushed into the
   * next real command step (not gherkin markers) by `takePending`, so each
   * entry attaches to the command during which it occurred.
   */
  pendingConsole: ConsoleEntry[];
  pendingNetwork: NetworkEntry[];
} = {
  steps: [],
  commandIndex: 0,
  testStartTime: 0,
  cappedCount: 0,
  evictedCount: 0,
  bundleBytes: 0,
  lastGherkinStepId: undefined,
  pendingConsole: [],
  pendingNetwork: [],
};

export function isEnabled(): boolean {
  return Cypress.env("FLAKEY_SNAPSHOTS_ENABLED") === true;
}

// Default per-step HTML cap: 2 MB. A pathological DOM (PDF viewer, giant data
// grid) can easily exceed V8's max string length (~500 MB) once accumulated
// across 300 ring-buffer steps, which crashes cy.task's JSON.stringify. Cap
// per-step so one oversized snapshot can't poison the whole bundle.
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;

// Default aggregate cap across all steps in one test: 64 MB. Second line of
// defence against bundles that stay under the per-step cap but accumulate to
// something cy.task cannot JSON-serialize. Oldest steps are evicted FIFO until
// the running total fits.
const DEFAULT_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export function getMaxHtmlBytes(): number {
  const v = Cypress.env("FLAKEY_SNAPSHOTS_MAX_HTML_BYTES");
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HTML_BYTES;
}

export function getMaxBundleBytes(): number {
  const v = Cypress.env("FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES");
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUNDLE_BYTES;
}

export function capHtml(html: string): string {
  const max = getMaxHtmlBytes();
  if (html.length <= max) return html;
  state.cappedCount++;
  const kb = Math.round(html.length / 1024);
  const maxKb = Math.round(max / 1024);
  try {
    console.warn(
      `[flakey-snapshots] DOM exceeded per-step cap: ${kb}KB > ${maxKb}KB. Placeholder substituted.`
    );
  } catch {}
  return `<!DOCTYPE html>\n<html><head><base href="about:blank"></head><body><pre data-flakey-skipped="true" style="font-family:system-ui;padding:1rem;color:#888">[flakey-snapshots] DOM skipped: serialized size ${kb}KB exceeded cap ${maxKb}KB</pre></body></html>`;
}

export function serializeDOM(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach((s) => s.remove());
  const head = clone.querySelector("head");
  // Inject <base href="…"> pointing at the captured page's origin so that
  // relative asset URLs inside the snapshot (images, fonts, hashed CSS
  // bundles like `/styles.6152230b54de2b15.css`, `/assets/images/*.svg`)
  // resolve against the test app's origin when the snapshot is replayed in
  // the dashboard iframe. Without this, the viewer's origin (e.g.
  // localhost:7777) is used and every asset 404s. Skip if the captured
  // page already has a <base> tag — the existing one is authoritative.
  try {
    if (head && !head.querySelector("base")) {
      const base = doc.createElement("base");
      base.setAttribute("href", doc.baseURI || (doc.location?.href ?? ""));
      head.insertBefore(base, head.firstChild);
    }
  } catch {}
  try {
    // Fold ONLY <link>-originated stylesheets into one inline <style>. Inline
    // <style> elements are already in the clone — re-inlining them (the old
    // code iterated every sheet) duplicated their rules. Track which sheet
    // hrefs we actually captured so we remove only those <link>s.
    const captured = new Set<string>();
    let cssText = "";
    for (const sheet of Array.from(doc.styleSheets)) {
      if (!sheet.href) continue; // skip inline <style> sheets
      try {
        cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join("\n") + "\n";
        captured.add(sheet.href);
      } catch {
        // Cross-origin sheet: cssRules throws SecurityError. Leave its <link>
        // in place (below) so the snapshot still references the external CSS
        // rather than silently losing it.
      }
    }
    if (cssText && head) {
      const styleEl = doc.createElement("style");
      styleEl.setAttribute("data-flakey-inlined", "true");
      styleEl.textContent = cssText;
      // Remove only the <link>s whose CSS we inlined; keep uncaptured/cross-
      // origin links. Resolve each link's href against the document base so the
      // comparison is robust for detached (cloned) nodes.
      head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
        const raw = l.getAttribute("href");
        if (!raw) return;
        let abs: string;
        try { abs = new URL(raw, doc.baseURI).href; } catch { return; }
        if (captured.has(abs)) l.remove();
      });
      head.appendChild(styleEl);
    }
  } catch {}
  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

export function getAppDocument(): Document | null {
  try {
    const aut = (window as any).top?.document?.querySelector("iframe.aut-iframe") as HTMLIFrameElement | null;
    if (aut?.contentDocument) return aut.contentDocument;
    const $aut = (Cypress as any).$("iframe.aut-iframe", (window as any).top?.document);
    if ($aut.length && $aut[0].contentDocument) return $aut[0].contentDocument;
  } catch {}
  return null;
}

const MAX_STEPS = 300;

// Per-step caps on attached context, mirroring the Playwright snapshots package
// so a chatty page (polling XHR, console spam) can't bloat the bundle. Applied
// to the PENDING buffer — i.e. per inter-command window, which becomes one step.
const MAX_CONSOLE_PER_STEP = 100;
const MAX_NETWORK_PER_STEP = 50;

// Cypress / browser console levels → the normalized level the viewer styles by.
function normalizeConsoleLevel(l: string): string {
  if (l === "warning") return "warn";
  if (l === "error" || l === "warn" || l === "info" || l === "debug" || l === "log") return l;
  return "log";
}

function fmtArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Buffer a console line for the current step. No-op when snapshots are off. */
export function recordConsole(level: string, text: string): void {
  if (!isEnabled()) return;
  if (state.pendingConsole.length >= MAX_CONSOLE_PER_STEP) return;
  state.pendingConsole.push({ level: normalizeConsoleLevel(level), text });
}

/** Buffer a network request for the current step. No-op when snapshots are off. */
export function recordNetwork(method: string, url: string, status?: number): void {
  if (!isEnabled()) return;
  if (!url) return;
  if (state.pendingNetwork.length >= MAX_NETWORK_PER_STEP) return;
  state.pendingNetwork.push(status !== undefined ? { method, url, status } : { method, url });
}

/**
 * Drain the pending console/network buffers into a `{console?, network?}` shape
 * to spread onto the step being created. Empty buffers contribute no key, so a
 * step with nothing observed stays unchanged (and backward-compatible).
 */
export function takePending(): { console?: ConsoleEntry[]; network?: NetworkEntry[] } {
  const out: { console?: ConsoleEntry[]; network?: NetworkEntry[] } = {};
  if (state.pendingConsole.length > 0) {
    out.console = state.pendingConsole;
    state.pendingConsole = [];
  }
  if (state.pendingNetwork.length > 0) {
    out.network = state.pendingNetwork;
    state.pendingNetwork = [];
  }
  return out;
}

/**
 * Wrap an application window's `console`, `fetch`, and `XMLHttpRequest` so each
 * call is buffered into the current step's pending console/network. Extracted
 * (rather than inlined in the support file's `window:before:load` handler) so
 * the interception is unit-testable against a fake window in Node.
 *
 * No-op when snapshots are disabled. Safe to run after the reporter's own
 * failure-context wrapping (each layer records into its own buffer and calls
 * through, so neither double-counts within a buffer).
 */
export function instrumentWindow(win: any): void {
  if (!isEnabled() || !win) return;

  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = win.console?.[level];
    if (typeof orig !== "function") continue;
    win.console[level] = (...args: unknown[]) => {
      recordConsole(level, args.map(fmtArg).join(" "));
      return orig.apply(win.console, args);
    };
  }

  const origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (this: unknown, ...args: any[]) {
      const req = args[0];
      const method = String(args[1]?.method ?? (req && req.method) ?? "GET").toUpperCase();
      const url = typeof req === "string" ? req : (req?.url ?? "");
      return origFetch.apply(this, args).then(
        (res: any) => {
          recordNetwork(method, url, typeof res?.status === "number" ? res.status : undefined);
          return res;
        },
        (err: any) => {
          recordNetwork(method, url, undefined); // never completed
          throw err;
        },
      );
    };
  }

  const XHR = win.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: any, method: string, url: string, ...rest: any[]) {
      this.__flakeySnapMethod = String(method ?? "GET").toUpperCase();
      this.__flakeySnapUrl = url ?? "";
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: any, ...rest: any[]) {
      try {
        this.addEventListener("loadend", () => {
          recordNetwork(this.__flakeySnapMethod, this.__flakeySnapUrl, this.status === 0 ? undefined : this.status);
        });
      } catch { /* environments without addEventListener — skip */ }
      return origSend.apply(this, rest);
    };
  }
}

/** Reset per-test accounting. Call from `test:before:run`. */
export function resetState(): void {
  state.steps = [];
  state.commandIndex = 0;
  state.testStartTime = Date.now();
  state.cappedCount = 0;
  state.evictedCount = 0;
  state.bundleBytes = 0;
  state.lastGherkinStepId = undefined;
  state.pendingConsole = [];
  state.pendingNetwork = [];
}

/**
 * Emit a synthetic "gherkin" marker step when the active Gherkin step changes,
 * so the snapshot viewer groups DOM steps under each Given / When / Then.
 *
 * Deduped by pickle-step id: whichever source observes a new step first wins,
 * the other no-ops. That lets the support-file detector (reads
 * `window.testState.pickleStep` after each command) and the optional
 * `./cucumber` BeforeStep hook coexist without double-marking — so Gherkin
 * grouping works from the support import alone, with no extra step-def file.
 * Returns true if a marker was pushed.
 */
export function markGherkinStep(
  id: string | undefined,
  type: string | undefined,
  text: string | undefined,
): boolean {
  if (!id || !text || id === state.lastGherkinStepId) return false;
  state.lastGherkinStepId = id;
  pushStep("gherkin", gherkinMarkerMessage(type, text));
  return true;
}

/**
 * Evict the oldest steps from the ring buffer until the running `bundleBytes`
 * total fits under the aggregate cap. Safe to call after any step push,
 * including the `afterEach` failure-state snapshot.
 */
export function enforceBundleSize(): void {
  const cap = getMaxBundleBytes();
  while (state.steps.length > 0 && state.bundleBytes > cap) {
    const dropped = state.steps.shift();
    if (dropped) {
      state.bundleBytes -= dropped.html.length;
      state.evictedCount++;
    }
  }
}

/** Append a step and keep ring-buffer + byte accounting in sync. */
export function appendStep(step: SnapshotStep): void {
  state.steps.push(step);
  state.bundleBytes += step.html.length;
  while (state.steps.length > MAX_STEPS) {
    const dropped = state.steps.shift();
    if (dropped) {
      state.bundleBytes -= dropped.html.length;
      // Count ring-buffer evictions too — otherwise a test with >300 commands
      // silently drops its oldest steps while the summary reports "0 evicted".
      state.evictedCount++;
    }
  }
  enforceBundleSize();
}

export function pushStep(name: string, message: string): void {
  if (!isEnabled()) return;
  const doc = getAppDocument();
  if (!doc) return;
  try {
    const html = capHtml(serializeDOM(doc));
    const win = doc.defaultView;
    // Gherkin markers are group boundaries, not commands — they must not claim
    // the console/network captured during the real command that follows, so
    // only real steps drain the pending buffers.
    const extra = name === "gherkin" ? {} : takePending();
    appendStep({
      index: state.commandIndex++,
      commandName: name,
      commandMessage: message,
      timestamp: Date.now() - state.testStartTime,
      html,
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
      ...extra,
    });
  } catch {}
}
