import type { NormalizedRun } from "../types.js";
import type { CheckAnnotation } from "./types.js";

// Cap total annotations so a catastrophic run (thousands of failures) doesn't
// fan out into dozens of Checks API calls. The PR comment + commit status still
// report the full totals; annotations are a navigation aid, not an exhaustive
// list. GitHub batches these 50/request, so 100 = at most 2 calls.
export const MAX_ANNOTATIONS = 100;

type NormalizedTest = NormalizedRun["specs"][number]["tests"][number];

// Best-effort: turn a failed test into an inline diff location. Pulls file/line
// from whatever the reporter captured — Playwright's metadata.location, or
// Cypress's source-map-resolved failure_context.code_frame (Phase 13). Returns
// null when no file is known (mochawesome/JUnit) — those tests still appear in
// the PR comment, just not as inline annotations.
function deriveLocation(test: NormalizedTest): { path: string; line: number } | null {
  const loc = (test.metadata as { location?: { file?: string; line?: number } } | undefined)?.location;
  const codeFrame = test.failure_context?.code_frame;
  const file = loc?.file ?? codeFrame?.file;
  if (!file) return null;
  const line = loc?.line ?? codeFrame?.line ?? 1;
  // Normalise toward a repo-relative path: drop a leading slash / "./".
  return { path: file.replace(/^\.?\//, ""), line: line > 0 ? line : 1 };
}

/**
 * Build inline check annotations for the failed tests in a run. Pure — exported
 * so the derivation + cap are unit-testable without the GitHub API call.
 */
export function buildCheckAnnotations(run: NormalizedRun): CheckAnnotation[] {
  const annotations: CheckAnnotation[] = [];
  for (const spec of run.specs) {
    for (const test of spec.tests) {
      if (test.status !== "failed") continue;
      const loc = deriveLocation(test);
      if (!loc) continue;
      const message = (test.error?.message ?? "Test failed")
        .split("\n").slice(0, 6).join("\n").slice(0, 600);
      annotations.push({
        path: loc.path,
        start_line: loc.line,
        end_line: loc.line,
        annotation_level: "failure",
        title: test.full_title.slice(0, 255),
        message,
      });
      if (annotations.length >= MAX_ANNOTATIONS) return annotations;
    }
  }
  return annotations;
}
