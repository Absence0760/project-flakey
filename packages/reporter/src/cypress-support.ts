/**
 * Cypress support file for command log capture.
 * Import in cypress/support/e2e.ts:
 *   import "@flakeytesting/reporter/support";
 */

declare const Cypress: any;
declare const cy: any;

interface CommandEntry {
  name: string;
  message: string;
  state: string;
}

let currentCommands: CommandEntry[] = [];

const skip = new Set(["xhr", "request", "route", "new url", "page load", "task"]);

// Buffer commands as they're logged
Cypress.on("log:added" as any, (log: any) => {
  const name = log.name;
  if (!name || skip.has(name)) return;

  currentCommands.push({
    name,
    message: log.message ?? "",
    state: log.state ?? "passed",
  });
});

// Update command state when it changes (e.g. assertion fails)
Cypress.on("log:changed" as any, (log: any) => {
  const name = log.name;
  if (!name || skip.has(name)) return;

  // Find the last command with this name and update its state
  for (let i = currentCommands.length - 1; i >= 0; i--) {
    if (currentCommands[i].name === name && currentCommands[i].message === (log.message ?? "")) {
      currentCommands[i].state = log.state ?? currentCommands[i].state;
      break;
    }
  }
});

// Reset before each test
beforeEach(() => {
  currentCommands = [];
});

// Save command log after each test
afterEach(() => {
  if (currentCommands.length === 0) return;

  // Update the last command's state if the test failed
  const state = (Cypress as any).state?.("runnable")?.state;
  if (state === "failed" && currentCommands.length > 0) {
    currentCommands[currentCommands.length - 1].state = "failed";
  }

  // Save to a temp file via task
  const testTitle = (Cypress as any).currentTest?.title ?? "unknown";
  const specFile = (Cypress as any).spec?.relative ?? Cypress.spec?.name ?? "unknown";

  cy.task("flakey:saveCommandLog", {
    testTitle,
    specFile,
    commands: [...currentCommands],
  }, { log: false }).then(() => {}, () => {});
});
