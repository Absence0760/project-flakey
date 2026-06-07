/**
 * Cypress support file for DOM snapshot capture.
 * Import this in cypress/support/e2e.ts:
 *   import "@flakeytesting/cypress-snapshots/support";
 *
 * Captures a DOM snapshot after each Cypress command completes.
 *
 * Cucumber: Gherkin step grouping works automatically from this import — the
 * command:end handler watches @badeball's active pickle step
 * (`window.testState.pickleStep`) and emits a step marker when it changes. The
 * separate `import "@flakeytesting/cypress-snapshots/cucumber"` is now OPTIONAL
 * (it registers an authoritative BeforeStep hook that fires before the step's
 * first command; markGherkinStep dedupes so the two never double-mark).
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
  markGherkinStep,
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
  // Cucumber grouping (no extra wiring): when @badeball advances to a new
  // Gherkin step it updates window.testState.pickleStep. Emit a step marker on
  // change — deduped by id so the optional ./cucumber BeforeStep hook (which
  // fires earlier) never produces a duplicate.
  try {
    const ps = (window as any).testState?.pickleStep;
    if (ps) markGherkinStep(ps.id, ps.type, ps.text);
  } catch { /* not a Cucumber run — no testState */ }
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
