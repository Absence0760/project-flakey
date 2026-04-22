// Registers Flakey's BeforeStep hook inside the cucumber preprocessor's
// per-feature registry. This file is picked up automatically by the
// stepDefinitions glob in .cypress-cucumber-preprocessorrc.json.
//
// Do NOT import @flakeytesting/cypress-snapshots/cucumber from
// cypress/support/e2e.ts — the support file runs outside the preprocessor
// registry and @badeball/cypress-cucumber-preprocessor throws
// "Expected to find a global registry" when you try to register hooks
// there.
console.log("[flakey-cucumber-hooks] module loaded");
import "@flakeytesting/cypress-snapshots/cucumber";
