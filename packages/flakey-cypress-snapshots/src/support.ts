/**
 * Cypress support file for DOM snapshot capture.
 * Import this in cypress/support/e2e.ts:
 *   import "@flakeytesting/cypress-snapshots/support";
 *
 * Captures a DOM snapshot after each Cypress command completes.
 */

interface SnapshotStep {
  index: number;
  commandName: string;
  commandMessage: string;
  timestamp: number;
  html: string;
  scrollX: number;
  scrollY: number;
}

let steps: SnapshotStep[] = [];
let commandIndex = 0;
let testStartTime = 0;

function serializeDOM(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;

  // Remove scripts
  clone.querySelectorAll("script").forEach((s) => s.remove());

  // Inline stylesheets
  try {
    const styleSheets = Array.from(doc.styleSheets);
    let cssText = "";
    for (const sheet of styleSheets) {
      try {
        cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join("\n") + "\n";
      } catch {}
    }
    if (cssText) {
      const styleEl = doc.createElement("style");
      styleEl.setAttribute("data-flakey-inlined", "true");
      styleEl.textContent = cssText;
      const head = clone.querySelector("head");
      if (head) {
        head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
        head.appendChild(styleEl);
      }
    }
  } catch {}

  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

function getAppDocument(): Document | null {
  try {
    const aut = (window as any).top?.document?.querySelector("iframe.aut-iframe") as HTMLIFrameElement | null;
    if (aut?.contentDocument) return aut.contentDocument;

    const $aut = (Cypress as any).$("iframe.aut-iframe", (window as any).top?.document);
    if ($aut.length && $aut[0].contentDocument) return $aut[0].contentDocument;
  } catch {}
  return null;
}

const SKIP_COMMANDS = new Set([
  "log", "wrap", "then", "should", "and", "its", "invoke",
  "as", "within", "wait", "task", "exec", "readFile", "writeFile",
  "fixture", "screenshot", "debug", "pause",
]);

Cypress.on("test:before:run", () => {
  steps = [];
  commandIndex = 0;
  testStartTime = Date.now();
});

Cypress.on("command:end", (command: any) => {
  const name = command?.attributes?.name;
  if (!name || SKIP_COMMANDS.has(name)) return;
  if (steps.length >= 100) return;

  const doc = getAppDocument();
  if (!doc) return;

  try {
    const html = serializeDOM(doc);
    const win = doc.defaultView;
    steps.push({
      index: commandIndex++,
      commandName: name,
      commandMessage: String(command?.attributes?.message || ""),
      timestamp: Date.now() - testStartTime,
      html,
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
    });
  } catch {}
});

afterEach(function () {
  // Capture the final DOM state if the test failed (the failing command's command:end doesn't fire)
  const testState = (this as any).currentTest?.state ?? (Cypress as any).state?.("runnable")?.state;
  if (testState === "failed") {
    const doc = getAppDocument();
    if (doc) {
      try {
        const html = serializeDOM(doc);
        const win = doc.defaultView;
        steps.push({
          index: commandIndex++,
          commandName: "failure",
          commandMessage: "Test failed — final DOM state",
          timestamp: Date.now() - testStartTime,
          html,
          scrollX: win?.scrollX ?? 0,
          scrollY: win?.scrollY ?? 0,
        });
      } catch {}
    }
  }

  if (steps.length === 0) return;

  const bundle = {
    version: 1,
    testTitle: (Cypress as any).currentTest?.title ?? "unknown",
    specFile: (Cypress as any).spec?.relative || Cypress.spec?.name || "",
    steps: [...steps],
    viewportWidth: Cypress.config("viewportWidth"),
    viewportHeight: Cypress.config("viewportHeight"),
  };

  cy.task("flakey:saveSnapshot", bundle, { log: false });
});
