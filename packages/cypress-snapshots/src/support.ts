/**
 * Cypress support file for DOM snapshot capture.
 * Import this in cypress/support/e2e.ts:
 *   import "@flakey/cypress-snapshots/support";
 *
 * Captures a DOM snapshot after each Cypress command completes.
 * Snapshots are serialized HTML with inlined styles.
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

interface SnapshotBundle {
  version: 1;
  testTitle: string;
  specFile: string;
  steps: SnapshotStep[];
  viewportWidth: number;
  viewportHeight: number;
}

let currentBundle: SnapshotBundle | null = null;
let commandIndex = 0;
let testStartTime = 0;

function serializeDOM(doc: Document): string {
  // Clone the document to avoid modifying the live DOM
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;

  // Remove all script tags
  const scripts = clone.querySelectorAll("script");
  scripts.forEach((s) => s.remove());

  // Inline computed styles for key elements to preserve visual state
  try {
    const styleSheets = Array.from(doc.styleSheets);
    let cssText = "";
    for (const sheet of styleSheets) {
      try {
        const rules = Array.from(sheet.cssRules);
        cssText += rules.map((r) => r.cssText).join("\n") + "\n";
      } catch {
        // Cross-origin stylesheets can't be read — skip
      }
    }

    if (cssText) {
      const styleEl = doc.createElement("style");
      styleEl.setAttribute("data-flakey-inlined", "true");
      styleEl.textContent = cssText;
      const head = clone.querySelector("head");
      if (head) {
        // Remove existing link[rel=stylesheet] since we inlined them
        const links = head.querySelectorAll('link[rel="stylesheet"]');
        links.forEach((l) => l.remove());
        head.appendChild(styleEl);
      }
    }
  } catch {
    // Style inlining failed — snapshot will still work but may look different
  }

  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

function getAppDocument(): Document | null {
  try {
    // Cypress runs the app in an iframe called "aut" (app under test)
    const aut = (window as any).top?.document?.querySelector(
      "iframe.aut-iframe"
    ) as HTMLIFrameElement | null;
    if (aut?.contentDocument) return aut.contentDocument;

    // Fallback: try cy.state
    const $autIframe = (Cypress as any).$(
      "iframe.aut-iframe",
      (window as any).top?.document
    );
    if ($autIframe.length && $autIframe[0].contentDocument) {
      return $autIframe[0].contentDocument;
    }
  } catch {}
  return null;
}

// Skip commands that don't change the DOM
const SKIP_COMMANDS = new Set([
  "log", "wrap", "then", "should", "and", "its", "invoke",
  "as", "within", "wait", "task", "exec", "readFile", "writeFile",
  "fixture", "screenshot", "debug", "pause",
]);

Cypress.on("test:before:run", (test) => {
  commandIndex = 0;
  testStartTime = Date.now();
  currentBundle = {
    version: 1,
    testTitle: test.title,
    specFile: (Cypress as any).spec?.relative || Cypress.spec?.name || "",
    steps: [],
    viewportWidth: Cypress.config("viewportWidth"),
    viewportHeight: Cypress.config("viewportHeight"),
  };
});

Cypress.on("command:end", (command: any) => {
  if (!currentBundle) return;

  const name = command?.attributes?.name;
  if (!name || SKIP_COMMANDS.has(name)) return;

  // Cap at 100 steps per test
  if (currentBundle.steps.length >= 100) return;

  const doc = getAppDocument();
  if (!doc) return;

  try {
    const html = serializeDOM(doc);
    const win = doc.defaultView;

    currentBundle.steps.push({
      index: commandIndex++,
      commandName: name,
      commandMessage: String(command?.attributes?.message || ""),
      timestamp: Date.now() - testStartTime,
      html,
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
    });
  } catch {
    // Serialization failed for this step — skip
  }
});

Cypress.on("test:after:run", (test) => {
  if (!currentBundle || currentBundle.steps.length === 0) return;

  // Send to Node via cy.task
  const bundle = currentBundle;
  currentBundle = null;

  // Use Cypress.backend to call the task without chaining
  try {
    (Cypress as any).backend("task", {
      task: "flakey:saveSnapshot",
      arg: bundle,
    }).catch(() => {
      // Task failed — snapshot won't be saved but test continues
    });
  } catch {
    // Fallback: store in window for manual retrieval
    (window as any).__flakeyLastSnapshot = bundle;
  }
});
