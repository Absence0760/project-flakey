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
    const html = serializeDOM(doc);
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
