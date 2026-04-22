/**
 * Optional Cucumber integration. Imports a BeforeStep hook that injects a
 * synthetic "gherkin" step into the snapshot bundle before each Gherkin
 * step runs, so scenario structure is visible in the snapshot viewer.
 *
 * IMPORTANT: do NOT import this module from cypress/support/e2e.ts.
 * `@badeball/cypress-cucumber-preprocessor`'s BeforeStep() registers into
 * a per-feature registry that only exists while the preprocessor is
 * processing a feature file. Called from the support file, it throws:
 *   "Expected to find a global registry (this usually means you are
 *    trying to define steps or hooks in support/e2e.js, which is not
 *    supported)"
 * which is swallowed by Cypress as "An uncaught error was detected
 * outside of a test" with no further detail — aborting the entire spec
 * before any tests run.
 *
 * Instead, import it from a file matched by the preprocessor's
 * stepDefinitions glob (usually `cypress/e2e/**\/*.ts` — see
 * `.cypress-cucumber-preprocessorrc.json`). A single-line file like this:
 *
 *   // cypress/e2e/_flakey-cucumber-hooks.ts
 *   import "@flakeytesting/cypress-snapshots/cucumber";
 *
 * is sufficient.
 *
 * Requires `@badeball/cypress-cucumber-preprocessor` (optional peer).
 */

import { BeforeStep } from "@badeball/cypress-cucumber-preprocessor";
import { pushStep } from "./shared.js";

const KEYWORD_FOR_TYPE: Record<string, string> = {
  Context: "Given",
  Action: "When",
  Outcome: "Then",
};

// BeforeStep is resolved at bundle time, but older versions of
// @badeball/cypress-cucumber-preprocessor may export it as `undefined`. If
// we called an undefined function at module load we would throw a
// TypeError and break the ENTIRE support bundle — meaning no Flakey
// reporter hooks, no snapshot capture, no cy.log wiring, and silently
// empty runs. Guard so this file no-ops cleanly when the host project's
// preprocessor version doesn't expose BeforeStep.
if (typeof BeforeStep === "function") {
  // The preprocessor calls: hook.implementation.call(world, options)
  // where options includes { pickle, pickleStep, gherkinDocument, ... }
  BeforeStep(function (options: any) {
    const ps = options?.pickleStep ?? (window as any).testState?.pickleStep;
    if (!ps?.text) return;
    const keyword = KEYWORD_FOR_TYPE[ps.type as string] ?? "Step";
    pushStep("gherkin", `${keyword} ${ps.text}`);
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[flakey-snapshots/cucumber] BeforeStep not available on this version of " +
      "@badeball/cypress-cucumber-preprocessor — Gherkin step markers disabled."
  );
}
