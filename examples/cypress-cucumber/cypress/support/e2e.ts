// Support file — runs before every spec
import "@flakeytesting/cypress-reporter/support";
import "@flakeytesting/cypress-snapshots/support";
import "cypress-axe";
// NOTE: @flakeytesting/cypress-snapshots/cucumber must NOT be imported here.
// It calls BeforeStep() which requires the cucumber preprocessor's
// per-feature registry. The support file runs outside that registry, so
// importing it here throws "Expected to find a global registry".
// That import lives in cypress/e2e/_flakey-cucumber-hooks.ts instead, where
// the preprocessor picks it up via the stepDefinitions glob.
