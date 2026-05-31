import { describe, it, expect } from "vitest";

import {
  normalizeGherkinText,
  snapshotIdxForCommandGroup,
  snapshotIdxForCommandChild,
  type CommandGroup,
  type SnapshotStepLite,
} from "./snapshot-match";

/**
 * Issue #26: the strict-pin behaviour in ErrorModal depends on these
 * helpers returning null when no match exists, so the click handler
 * can raise a "no snapshot for this step" toast instead of silently
 * pinning a neighbouring step's snapshot. These tests pin the
 * contract.
 */

const gherkin = (commandMessage: string): SnapshotStepLite => ({
  commandName: "gherkin",
  commandMessage,
});
const action = (commandName: string): SnapshotStepLite => ({
  commandName,
  commandMessage: "",
});

describe("normalizeGherkinText", () => {
  it("strips markdown bold and lowercases", () => {
    expect(normalizeGherkinText("**Foo** bar")).toBe("foo bar");
  });
  it("collapses internal whitespace", () => {
    expect(normalizeGherkinText("a   b\n\tc")).toBe("a b c");
  });
  it("trims leading/trailing whitespace", () => {
    expect(normalizeGherkinText("   hi   ")).toBe("hi");
  });
  it("is empty on empty/whitespace input", () => {
    expect(normalizeGherkinText("")).toBe("");
    expect(normalizeGherkinText("   ")).toBe("");
  });
});

describe("snapshotIdxForCommandGroup", () => {
  const commandGroups: CommandGroup[] = [
    { headerIdx: null, headerLabel: "Setup", headerKeyword: "SETUP", childIdxs: [0] },
    { headerIdx: 1, headerLabel: "the user is on /login", headerKeyword: "GIVEN", childIdxs: [2, 3] },
    { headerIdx: 4, headerLabel: "the user submits the form", headerKeyword: "WHEN", childIdxs: [5, 6] },
    { headerIdx: 7, headerLabel: "the user lands on /dashboard", headerKeyword: "THEN", childIdxs: [8] },
  ];
  const snapshotSteps: SnapshotStepLite[] = [
    action("visit"),
    gherkin("Given the user is on /login"),
    action("get"),
    action("type"),
    gherkin("When the user submits the form"),
    action("get"),
    action("click"),
    gherkin("Then the user lands on /dashboard"),
    action("should"),
  ];

  it("matches GIVEN/WHEN/THEN headers to their gherkin markers in order", () => {
    expect(snapshotIdxForCommandGroup(commandGroups, snapshotSteps, 1)).toBe(1);
    expect(snapshotIdxForCommandGroup(commandGroups, snapshotSteps, 2)).toBe(4);
    expect(snapshotIdxForCommandGroup(commandGroups, snapshotSteps, 3)).toBe(7);
  });

  it("resolves SETUP to the first non-gherkin step", () => {
    expect(snapshotIdxForCommandGroup(commandGroups, snapshotSteps, 0)).toBe(0);
  });

  it("returns null when the gherkin label has no matching marker in the bundle", () => {
    const noMatch: CommandGroup[] = [
      { headerIdx: 0, headerLabel: "an entirely different step", headerKeyword: "GIVEN", childIdxs: [] },
    ];
    expect(snapshotIdxForCommandGroup(noMatch, snapshotSteps, 0)).toBeNull();
  });

  it("returns null when the bundle has no gherkin markers at all", () => {
    const onlyActions: SnapshotStepLite[] = [action("visit"), action("get"), action("click")];
    expect(snapshotIdxForCommandGroup(commandGroups, onlyActions, 1)).toBeNull();
  });

  it("disambiguates repeated step text by advancing to the next occurrence", () => {
    const repeated: CommandGroup[] = [
      { headerIdx: 0, headerLabel: "the user clicks X", headerKeyword: "AND", childIdxs: [] },
      { headerIdx: 1, headerLabel: "the user clicks X", headerKeyword: "AND", childIdxs: [] },
    ];
    const bundle: SnapshotStepLite[] = [
      gherkin("And the user clicks X"),
      gherkin("And the user clicks X"),
    ];
    expect(snapshotIdxForCommandGroup(repeated, bundle, 0)).toBe(0);
    expect(snapshotIdxForCommandGroup(repeated, bundle, 1)).toBe(1);
  });

  it("returns null for a gIdx that is out of range", () => {
    expect(snapshotIdxForCommandGroup(commandGroups, snapshotSteps, 99)).toBeNull();
  });

  it("treats the bundle as authoritative — extra command-log group with no marker fails to match", () => {
    const groupsWithExtra: CommandGroup[] = [
      ...commandGroups,
      { headerIdx: 9, headerLabel: "step that wasn't captured", headerKeyword: "AND", childIdxs: [] },
    ];
    expect(snapshotIdxForCommandGroup(groupsWithExtra, snapshotSteps, 4)).toBeNull();
  });

  it("normalises markdown bold in the command-log header before matching", () => {
    const bolded: CommandGroup[] = [
      { headerIdx: 0, headerLabel: "the user is on **/login**", headerKeyword: "GIVEN", childIdxs: [] },
    ];
    const bundle: SnapshotStepLite[] = [gherkin("Given the user is on /login")];
    expect(snapshotIdxForCommandGroup(bolded, bundle, 0)).toBe(0);
  });
});

describe("snapshotIdxForCommandChild", () => {
  const commandGroups: CommandGroup[] = [
    { headerIdx: null, headerLabel: "Setup", headerKeyword: "SETUP", childIdxs: [0] },
    { headerIdx: 1, headerLabel: "the user is on /login", headerKeyword: "GIVEN", childIdxs: [2, 3] },
    { headerIdx: 4, headerLabel: "the user submits the form", headerKeyword: "WHEN", childIdxs: [5, 6, 7] },
  ];
  const snapshotSteps: SnapshotStepLite[] = [
    action("visit"),
    gherkin("Given the user is on /login"),
    action("get"),
    action("type"),
    gherkin("When the user submits the form"),
    action("get"),
    action("type"),
    action("click"),
  ];

  it("offsets children by their position within the group, after the gherkin marker", () => {
    // GIVEN sits at snapshot index 1; first child is index 2.
    expect(snapshotIdxForCommandChild(commandGroups, snapshotSteps, 1, 0)).toBe(2);
    expect(snapshotIdxForCommandChild(commandGroups, snapshotSteps, 1, 1)).toBe(3);
    // WHEN sits at index 4; first child is 5.
    expect(snapshotIdxForCommandChild(commandGroups, snapshotSteps, 2, 0)).toBe(5);
    expect(snapshotIdxForCommandChild(commandGroups, snapshotSteps, 2, 2)).toBe(7);
  });

  it("clamps an over-shooting child to the last step inside the group's range", () => {
    // GIVEN has only two real children (idx 2, 3). Asking for childPos=5
    // should clamp to the last in-group slot (3), not bleed into WHEN's
    // bundle range.
    const idx = snapshotIdxForCommandChild(commandGroups, snapshotSteps, 1, 5);
    expect(idx).toBe(3);
  });

  it("returns null when the parent group has no marker in the bundle", () => {
    const orphan: CommandGroup[] = [
      { headerIdx: 0, headerLabel: "step that wasn't captured", headerKeyword: "GIVEN", childIdxs: [1, 2] },
    ];
    const onlyMatch: SnapshotStepLite[] = [action("get"), action("click")];
    expect(snapshotIdxForCommandChild(orphan, onlyMatch, 0, 0)).toBeNull();
  });

  it("for SETUP, headerIdx already points at the first child — childPos 0 returns headerIdx", () => {
    expect(snapshotIdxForCommandChild(commandGroups, snapshotSteps, 0, 0)).toBe(0);
  });
});
