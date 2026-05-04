// Minimal Gherkin parser for importing .feature files as manual tests.
//
// Supports: Feature (+ description), Background, Scenario / Scenario Outline,
// tags, Given/When/Then/And/But steps, doc strings ("""), data tables (|…|),
// and Examples tables (expanded into one scenario per row). Intentionally
// ignores rules, i18n keywords, and anything else we don't need — this is a
// one-way importer, not a spec-compliant parser.

export interface ParsedStep {
  keyword: string;
  text: string;
  docstring?: string;
  table?: string[][];
}

export interface ParsedScenario {
  name: string;
  tags: string[];
  steps: ParsedStep[];
  lineNumber: number;
}

export interface ParsedFeature {
  name: string;
  description: string;
  tags: string[];
  background: ParsedStep[];
  scenarios: ParsedScenario[];
}

const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But", "*"];

function stripComment(line: string): string {
  // Don't strip inside table rows or docstrings — caller handles those.
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  // Cells are separated by unescaped pipes; the leading/trailing pipes are
  // empty and get dropped.
  const cells = trimmed.split("|").slice(1, -1);
  return cells.map((c) => c.trim());
}

function substituteExamples(text: string, headers: string[], row: string[]): string {
  let out = text;
  headers.forEach((h, i) => {
    out = out.split(`<${h}>`).join(row[i] ?? "");
  });
  return out;
}

export function parseFeature(source: string): ParsedFeature {
  const rawLines = source.split(/\r?\n/);

  const feature: ParsedFeature = {
    name: "",
    description: "",
    tags: [],
    background: [],
    scenarios: [],
  };

  let pendingTags: string[] = [];
  const descriptionLines: string[] = [];

  let section: "none" | "feature" | "background" | "scenario" | "outline" = "none";
  let current: ParsedScenario | null = null;
  let currentSteps: ParsedStep[] | null = null;
  let inExamples = false;

  // Scenario Outline state
  let examplesHeaders: string[] | null = null;
  let examplesRows: string[][] = [];
  let outlineTemplate: ParsedScenario | null = null;

  // In-progress multi-line step attachments
  let lastStep: ParsedStep | null = null;
  let docstring: string[] | null = null;
  let tableRows: string[][] | null = null;

  const flushOutline = () => {
    if (!outlineTemplate || !examplesHeaders) {
      examplesHeaders = null;
      examplesRows = [];
      outlineTemplate = null;
      return;
    }
    for (const row of examplesRows) {
      const expanded: ParsedScenario = {
        name: substituteExamples(outlineTemplate.name, examplesHeaders, row),
        tags: [...outlineTemplate.tags],
        lineNumber: outlineTemplate.lineNumber,
        steps: outlineTemplate.steps.map((s) => ({
          keyword: s.keyword,
          text: substituteExamples(s.text, examplesHeaders!, row),
          docstring: s.docstring
            ? substituteExamples(s.docstring, examplesHeaders!, row)
            : undefined,
          table: s.table?.map((r) =>
            r.map((c) => substituteExamples(c, examplesHeaders!, row))
          ),
        })),
      };
      feature.scenarios.push(expanded);
    }
    examplesHeaders = null;
    examplesRows = [];
    outlineTemplate = null;
  };

  const closeStep = () => {
    if (!lastStep) return;
    if (docstring) {
      lastStep.docstring = docstring.join("\n");
      docstring = null;
    }
    if (tableRows) {
      lastStep.table = tableRows;
      tableRows = null;
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNo = i + 1;

    // Docstring passthrough — preserve content verbatim
    if (docstring !== null) {
      if (raw.trim() === '"""' || raw.trim() === "```") {
        closeStep();
        continue;
      }
      docstring.push(raw);
      continue;
    }

    const line = stripComment(raw).trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;

    // Tag line
    if (trimmed.startsWith("@")) {
      closeStep();
      pendingTags.push(...trimmed.split(/\s+/).filter((t) => t.startsWith("@")));
      continue;
    }

    // Feature:
    if (/^Feature:/i.test(trimmed)) {
      closeStep();
      feature.name = trimmed.replace(/^Feature:/i, "").trim();
      feature.tags = pendingTags;
      pendingTags = [];
      section = "feature";
      continue;
    }

    // Background:
    if (/^Background:/i.test(trimmed)) {
      closeStep();
      if (section === "feature") feature.description = descriptionLines.join("\n").trim();
      section = "background";
      currentSteps = feature.background;
      continue;
    }

    // Scenario Outline:
    if (/^Scenario Outline:/i.test(trimmed) || /^Scenario Template:/i.test(trimmed)) {
      closeStep();
      flushOutline();
      inExamples = false;
      if (section === "feature") feature.description = descriptionLines.join("\n").trim();
      // Scenario tags do NOT include feature.tags. Tag inheritance is a
      // presentation concern — consumers that want feature-level filtering
      // should merge feature.tags + scenario.tags themselves. Mixing them
      // here loses the distinction and double-counts in tag filters.
      outlineTemplate = {
        name: trimmed.replace(/^Scenario (Outline|Template):/i, "").trim(),
        tags: [...pendingTags],
        steps: [],
        lineNumber: lineNo,
      };
      pendingTags = [];
      section = "outline";
      currentSteps = outlineTemplate.steps;
      continue;
    }

    // Scenario: / Example:
    if (/^(Scenario|Example):/i.test(trimmed)) {
      closeStep();
      flushOutline();
      inExamples = false;
      if (section === "feature") feature.description = descriptionLines.join("\n").trim();
      current = {
        name: trimmed.replace(/^(Scenario|Example):/i, "").trim(),
        tags: [...pendingTags],
        steps: [],
        lineNumber: lineNo,
      };
      pendingTags = [];
      feature.scenarios.push(current);
      section = "scenario";
      currentSteps = current.steps;
      continue;
    }

    // Examples:
    if (/^Examples:/i.test(trimmed) || /^Scenarios:/i.test(trimmed)) {
      closeStep();
      inExamples = true;
      examplesHeaders = null;
      examplesRows = [];
      currentSteps = null;
      continue;
    }

    // Table row (examples or step table)
    if (trimmed.startsWith("|")) {
      const cells = parseTableRow(raw);
      if (inExamples) {
        if (examplesHeaders === null) {
          examplesHeaders = cells;
        } else {
          examplesRows.push(cells);
        }
      } else if (lastStep) {
        if (!tableRows) tableRows = [];
        tableRows.push(cells);
      }
      continue;
    }

    // Docstring open
    if (trimmed === '"""' || trimmed === "```") {
      docstring = [];
      continue;
    }

    // Step
    const stepMatch = STEP_KEYWORDS.find((kw) =>
      trimmed === kw || trimmed.startsWith(kw + " ")
    );
    if (stepMatch && currentSteps) {
      closeStep();
      const text = trimmed.slice(stepMatch.length).trim();
      const step: ParsedStep = { keyword: stepMatch, text };
      currentSteps.push(step);
      lastStep = step;
      continue;
    }

    // Otherwise treat as feature-level description text
    if (section === "feature") {
      descriptionLines.push(trimmed);
    }
  }

  closeStep();
  flushOutline();
  if (section === "feature") feature.description = descriptionLines.join("\n").trim();

  return feature;
}

/**
 * Convert a parsed scenario into the {action, data, expected} step rows used
 * by the manual-tests table. Background steps are prepended so an imported
 * scenario is self-contained.
 */
export function scenarioToManualSteps(
  feature: ParsedFeature,
  scenario: ParsedScenario
): Array<{ action: string; data: string; expected: string }> {
  const all = [...feature.background, ...scenario.steps];

  // And/But inherit the intent of the previous concrete keyword, per Gherkin
  // conventions — so `Then X / And Y / And Z` all go in the expected column.
  let effective = "Given";
  return all.map((s) => {
    if (s.keyword === "Given" || s.keyword === "When" || s.keyword === "Then") {
      effective = s.keyword;
    }
    const full = `${s.keyword} ${s.text}`.trim();
    const isExpectation = effective === "Then";

    let data = "";
    if (s.docstring) data = s.docstring;
    else if (s.table) data = s.table.map((r) => "| " + r.join(" | ") + " |").join("\n");

    return {
      action: isExpectation ? "" : full,
      data,
      expected: isExpectation ? full : "",
    };
  });
}
