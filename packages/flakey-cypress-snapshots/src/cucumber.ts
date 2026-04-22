/**
 * Optional Cucumber integration. Import in your support bundle AFTER
 * `@flakeytesting/cypress-snapshots/support`:
 *
 *   import "@flakeytesting/cypress-snapshots/support";
 *   import "@flakeytesting/cypress-snapshots/cucumber";
 *
 * Requires `@badeball/cypress-cucumber-preprocessor` (peer). Inserts a
 * synthetic "gherkin" step into the snapshot bundle before each Gherkin
 * step runs so the scenario structure is visible in the snapshot viewer.
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
