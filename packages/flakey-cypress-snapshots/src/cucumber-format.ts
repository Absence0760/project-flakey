/**
 * Pure helpers for the bundle-side gherkin marker contract.
 *
 * Lives in its own module (no cucumber-preprocessor import) so it can
 * be unit-tested under node:test without dragging Cypress globals or
 * `@badeball/cypress-cucumber-preprocessor` into the test runtime.
 *
 * The frontend snapshot viewer's strict-pin (issue #26) keys on:
 *   - `commandName === "gherkin"` for snapshot steps that mark a
 *     Gherkin scenario step boundary, and
 *   - `commandMessage` containing the step's plain text (the matcher
 *     normalises whitespace + strips bold + lowercases, then uses
 *     `.includes(needle)`, so the leading "<Keyword>" word is allowed
 *     but not load-bearing).
 *
 * This module is what cucumber.ts uses to assemble the marker, so
 * pinning these helpers pins the bundle-side half of the contract.
 */

/**
 * Map a pickleStep `type` from cucumber-preprocessor to the
 * human-readable Gherkin keyword we prepend to the marker message.
 * Unknown types fall back to "Step" — never empty, so the
 * commandMessage always has a leading-keyword shape downstream
 * tools (CLI summaries, the snapshot viewer's step-name footer) can
 * rely on.
 */
export function gherkinKeywordForType(type: string | undefined | null): string {
  switch (type) {
    case "Context": return "Given";
    case "Action": return "When";
    case "Outcome": return "Then";
    default: return "Step";
  }
}

/**
 * Build the `commandMessage` for a `pushStep("gherkin", …)` call.
 * Strict shape: `"<Keyword> <step text>"`. Preserves the step text
 * verbatim — the viewer's normalisation handles whitespace +
 * markdown-bold matching against the command_log.
 */
export function gherkinMarkerMessage(type: string | undefined | null, text: string): string {
  return `${gherkinKeywordForType(type)} ${text}`;
}
