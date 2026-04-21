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
} = {
  steps: [],
  commandIndex: 0,
  testStartTime: 0,
};

export function isEnabled(): boolean {
  return Cypress.env("FLAKEY_SNAPSHOTS_ENABLED") === true;
}

// Default per-step HTML cap: 2 MB. A pathological DOM (PDF viewer, giant data
// grid) can easily exceed V8's max string length (~500 MB) once accumulated
// across 300 ring-buffer steps, which crashes cy.task's JSON.stringify. Cap
// per-step so one oversized snapshot can't poison the whole bundle.
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;

export function getMaxHtmlBytes(): number {
  const v = Cypress.env("FLAKEY_SNAPSHOTS_MAX_HTML_BYTES");
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HTML_BYTES;
}

export function capHtml(html: string): string {
  const max = getMaxHtmlBytes();
  if (html.length <= max) return html;
  const kb = Math.round(html.length / 1024);
  const maxKb = Math.round(max / 1024);
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

export function pushStep(name: string, message: string): void {
  if (!isEnabled()) return;
  const doc = getAppDocument();
  if (!doc) return;
  try {
    const html = capHtml(serializeDOM(doc));
    const win = doc.defaultView;
    state.steps.push({
      index: state.commandIndex++,
      commandName: name,
      commandMessage: message,
      timestamp: Date.now() - state.testStartTime,
      html,
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
    });
    while (state.steps.length > MAX_STEPS) state.steps.shift();
  } catch {}
}
