export interface SnapshotStep {
  index: number;
  commandName: string;
  commandMessage: string;
  timestamp: number;
  html: string;
  scrollX: number;
  scrollY: number;
}

export const state: {
  steps: SnapshotStep[];
  commandIndex: number;
  testStartTime: number;
  /** Number of per-step cap trips in the current test. */
  cappedCount: number;
  /** Number of steps evicted by the aggregate-bundle cap in the current test. */
  evictedCount: number;
  /** Running total of `html.length` across steps. Kept in sync by pushStep. */
  bundleBytes: number;
} = {
  steps: [],
  commandIndex: 0,
  testStartTime: 0,
  cappedCount: 0,
  evictedCount: 0,
  bundleBytes: 0,
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
    const styleSheets = Array.from(doc.styleSheets);
    let cssText = "";
    for (const sheet of styleSheets) {
      try { cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join("\n") + "\n"; } catch {}
    }
    if (cssText) {
      const styleEl = doc.createElement("style");
      styleEl.setAttribute("data-flakey-inlined", "true");
      styleEl.textContent = cssText;
      if (head) {
        head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
        head.appendChild(styleEl);
      }
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

/** Reset per-test accounting. Call from `test:before:run`. */
export function resetState(): void {
  state.steps = [];
  state.commandIndex = 0;
  state.testStartTime = Date.now();
  state.cappedCount = 0;
  state.evictedCount = 0;
  state.bundleBytes = 0;
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
    if (dropped) state.bundleBytes -= dropped.html.length;
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
    appendStep({
      index: state.commandIndex++,
      commandName: name,
      commandMessage: message,
      timestamp: Date.now() - state.testStartTime,
      html,
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
    });
  } catch {}
}
