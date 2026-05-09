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
