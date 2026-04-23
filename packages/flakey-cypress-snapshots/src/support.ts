/**
 * Cypress support file for DOM snapshot capture.
 * Import this in cypress/support/e2e.ts:
 *   import "@flakeytesting/cypress-snapshots/support";
 *
 * Captures a DOM snapshot after each Cypress command completes.
 *
 * For Cucumber users: additionally import
 *   import "@flakeytesting/cypress-snapshots/cucumber";
 * to get Gherkin step markers in the snapshot bundle.
 */

import {
  state,
  isEnabled,
  pushStep,
  serializeDOM,
  getAppDocument,
  capHtml,
  resetState,
  appendStep,
} from "./shared.js";

const SKIP_COMMANDS = new Set([
  "wrap", "then", "should", "and", "its", "invoke",
  "as", "within", "wait", "task", "exec", "readFile", "writeFile",
  "fixture", "screenshot", "debug", "pause",
]);

Cypress.on("test:before:run", () => {
  resetState();
});

Cypress.on("command:end", (command: any) => {
  if (!isEnabled()) return;
  const name = command?.attributes?.name;
  if (!name || SKIP_COMMANDS.has(name)) return;
  pushStep(name, String(command?.attributes?.message || ""));
});

afterEach(function () {
  if (!isEnabled()) return;

  const testState = (this as any).currentTest?.state ?? (Cypress as any).state?.("runnable")?.state;
  if (testState === "failed") {
    const doc = getAppDocument();
    if (doc) {
      try {
        const html = capHtml(serializeDOM(doc));
        const win = doc.defaultView;
        appendStep({
          index: state.commandIndex++,
          commandName: "failure",
          commandMessage: "Test failed — final DOM state",
          timestamp: Date.now() - state.testStartTime,
          html,
          scrollX: win?.scrollX ?? 0,
          scrollY: win?.scrollY ?? 0,
        });
      } catch {}
    }
  }

  if (state.steps.length === 0) return;

  if (state.cappedCount > 0 || state.evictedCount > 0) {
    try {
      console.warn(
        `[flakey-snapshots] ${state.cappedCount} step(s) placeholder'd, ` +
          `${state.evictedCount} step(s) evicted to fit bundle cap.`
      );
    } catch {}
  }

  const current = (Cypress as any).currentTest;
  const fullTitle = Array.isArray(current?.titlePath) && current.titlePath.length > 0
    ? current.titlePath.join(" ")
    : (current?.title ?? "unknown");
  const bundle = {
    version: 1,
    testTitle: fullTitle,
    specFile: (Cypress as any).spec?.relative || Cypress.spec?.name || "",
    steps: [...state.steps],
    viewportWidth: Cypress.config("viewportWidth"),
    viewportHeight: Cypress.config("viewportHeight"),
    cappedSteps: state.cappedCount,
    evictedSteps: state.evictedCount,
  };

  cy.task("flakey:saveSnapshot", bundle, { log: false });
});
