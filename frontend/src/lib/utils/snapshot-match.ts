/**
 * Pure mapping between a Cypress command_log and a DOM-replay snapshot
 * bundle. ErrorModal/SnapshotViewer use this to figure out which
 * snapshot step corresponds to a clicked command-log entry.
 *
 * Lives outside ErrorModal.svelte because:
 *   - the logic is non-trivial (issue #26's strict-pin behaviour
 *     depends on `snapshotIdxForCommandGroup` returning null cleanly
 *     when no match exists), and
 *   - it has nothing to do with Svelte runes — keeping it as plain
 *     functions makes it unit-testable in isolation.
 */

export interface SnapshotStepLite {
  commandName: string;
  commandMessage: string;
}

export interface ConsoleEntryLite {
  /** Normalized level: log | info | warn | error | debug. */
  level: string;
  text: string;
}

export interface NetworkEntryLite {
  method: string;
  url: string;
  status?: number;
}

export interface StepDiagnostics {
  consoleCount: number;
  networkCount: number;
  /** console errors + failed network requests — the at-a-glance "problem" signal. */
  errorCount: number;
}

/**
 * Per-step duration in ms, derived from the cumulative `timestamp` each step
 * carries (ms since the run/test start — both reporters now agree on ms).
 * `duration[i]` is the gap from the previous step; the first step is its own
 * timestamp. A missing or non-monotonic timestamp clamps to 0 rather than
 * producing a negative duration.
 */
export function stepDurationsMs(steps: { timestamp?: number }[]): number[] {
  return steps.map((s, i) => {
    const t = typeof s.timestamp === "number" ? s.timestamp : 0;
    const prev = i > 0 && typeof steps[i - 1].timestamp === "number" ? (steps[i - 1].timestamp as number) : 0;
    return Math.max(0, t - prev);
  });
}

/**
 * Indices of the "where did the time go" outlier steps. A step is slow when its
 * duration is BOTH >= `floorMs` (default 250ms — don't flag trivially-fast
 * steps in a fast test) AND >= `fraction` of the slowest step (default 0.5).
 * Returns a Set for O(1) membership while rendering rows. Empty when no step
 * clears the floor.
 */
export function slowStepIndices(durations: number[], floorMs = 250, fraction = 0.5): Set<number> {
  const max = durations.reduce((m, d) => Math.max(m, d), 0);
  if (max < floorMs) return new Set();
  const threshold = Math.max(floorMs, max * fraction);
  const out = new Set<number>();
  durations.forEach((d, i) => {
    if (d >= threshold) out.add(i);
  });
  return out;
}

/**
 * A network entry counts as a failure when it never completed (no status —
 * aborted / network error) or returned an HTTP error (>= 400). 3xx/2xx are
 * normal. Matches the Cypress reporter's `network_failures` capture rule.
 */
export function isNetworkFailure(status: number | undefined): boolean {
  return status === undefined || status >= 400;
}

/**
 * Per-step console + network counts used to badge step rows and summarize the
 * viewer's diagnostics strip. Pure so it can be shared by ErrorModal (list
 * badges) and SnapshotViewer (strip header) and unit-tested in isolation.
 */
export function stepDiagnostics(step: {
  console?: ConsoleEntryLite[];
  network?: NetworkEntryLite[];
} | null | undefined): StepDiagnostics {
  // Null-safe: a caller may resolve a step index before the bundle finishes
  // loading (snapshotSteps is empty for a tick), so `step` can be undefined.
  const consoleEntries = step?.console ?? [];
  const networkEntries = step?.network ?? [];
  const consoleErrors = consoleEntries.filter((c) => c.level === "error").length;
  const networkFailures = networkEntries.filter((n) => isNetworkFailure(n.status)).length;
  return {
    consoleCount: consoleEntries.length,
    networkCount: networkEntries.length,
    errorCount: consoleErrors + networkFailures,
  };
}

/**
 * Index of the snapshot bundle's failure frame, or null if the test passed.
 *
 * `@flakeytesting/cypress-snapshots`'s support file appends a single synthetic
 * step with `commandName === "failure"` ("Test failed — final DOM state") in
 * its afterEach ONLY when the test failed. So the failure frame is identified
 * by that marker — NOT by "the last step". The viewer is reachable for passed
 * tests too (any test's snapshot is browsable), so assuming the last step is a
 * failure painted a spurious red FAILURE tick on passing tests' final step.
 */
export function failureStepIndex(steps: SnapshotStepLite[]): number | null {
  const i = steps.findIndex((s) => s.commandName === "failure");
  return i >= 0 ? i : null;
}

export interface CommandGroup {
  /** Index of the gherkin header in command_log, or null for synthetic SETUP. */
  headerIdx: number | null;
  /** Human-readable step text (Cypress log.message), possibly with `**bold**`. */
  headerLabel: string;
  /** "GIVEN" / "WHEN" / "THEN" / "AND" / "BUT" / "SETUP". */
  headerKeyword: string;
  /** Indexes into command_log of the non-gherkin children under this group. */
  childIdxs: number[];
}

/**
 * Cypress's log.message uses markdown bolding (`**foo**`) and varying
 * whitespace. Snapshot bundles store the plain text. Normalise both
 * sides to a comparable form before equality-testing.
 */
export function normalizeGherkinText(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Strict resolution: which snapshot-bundle step corresponds to the
 * gherkin group at `gIdx` in `commandGroups`?
 *
 * Returns null when no match exists. Issue #26: callers MUST treat
 * null as "no snapshot for this step" and surface that to the user
 * (toast / disabled affordance) rather than falling back to a
 * neighbouring step's snapshot.
 *
 * SETUP groups always resolve to the first non-gherkin snapshot step
 * (or 0 if the bundle has none) — they don't appear in the bundle's
 * gherkin marker stream, so positional fallback is the only sensible
 * behaviour for them and not considered a "no match".
 */
export function snapshotIdxForCommandGroup(
  commandGroups: CommandGroup[],
  snapshotSteps: SnapshotStepLite[],
  gIdx: number,
): number | null {
  const group = commandGroups[gIdx];
  if (!group) return null;
  if (group.headerKeyword === "SETUP") {
    const first = snapshotSteps.findIndex((s) => s.commandName !== "gherkin");
    return first >= 0 ? first : 0;
  }
  // Walk every preceding gherkin group up to and including gIdx, marking
  // matched snapshot indices as consumed. This way a label that appears
  // twice in the command log (e.g. two "And the user clicks X") advances
  // to the next occurrence in the bundle instead of snapping back to the
  // first match every time.
  const consumed = new Set<number>();
  for (let i = 0; i <= gIdx; i++) {
    const g = commandGroups[i];
    if (g.headerKeyword === "SETUP") continue;
    const needle = normalizeGherkinText(g.headerLabel);
    const found = snapshotSteps.findIndex((s, si) => {
      if (s.commandName !== "gherkin" || consumed.has(si)) return false;
      return normalizeGherkinText(s.commandMessage ?? "").includes(needle);
    });
    if (found >= 0) {
      consumed.add(found);
      if (i === gIdx) return found;
    } else if (i === gIdx) {
      return null;
    }
  }
  return null;
}

/**
 * Strict resolution for a child command at `childPos` within group
 * `gIdx`. Children sit positionally after their group's gherkin marker
 * in the bundle — bundle slot = `markerIdx + 1 + childPos`, capped at
 * the next gherkin marker (or end of bundle).
 *
 * Returns null when the parent group itself has no match in the
 * bundle. If the child position overshoots the available slots in the
 * group's bundle range, returns the last available slot — which is
 * still strictly inside the group, so callers can pin it without
 * jumping to a sibling.
 */
export function snapshotIdxForCommandChild(
  commandGroups: CommandGroup[],
  snapshotSteps: SnapshotStepLite[],
  gIdx: number,
  childPos: number,
): number | null {
  const headerIdx = snapshotIdxForCommandGroup(commandGroups, snapshotSteps, gIdx);
  if (headerIdx === null) return null;
  // For Gherkin groups headerIdx points AT the gherkin marker — children
  // start one step later. For SETUP headerIdx already points at the first
  // child (no synthetic marker exists in snapshotSteps), so don't skip it.
  const isSetup = commandGroups[gIdx]?.headerKeyword === "SETUP";
  const base = isSetup ? headerIdx : headerIdx + 1;
  let endIdx = snapshotSteps.length;
  for (let i = base; i < snapshotSteps.length; i++) {
    if (snapshotSteps[i].commandName === "gherkin") { endIdx = i; break; }
  }
  const target = base + childPos;
  return target < endIdx ? target : Math.max(headerIdx, endIdx - 1);
}
