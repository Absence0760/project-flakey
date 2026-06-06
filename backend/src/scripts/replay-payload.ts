/**
 * Reporter payload replay CLI (Phase 13).
 *
 * Feed a captured reporter payload (Cypress/mochawesome JSON, Playwright JSON,
 * JUnit XML, Jest/WebdriverIO JSON) straight through the normalizer and dump
 * the resulting NormalizedRun — a sub-second loop on ingestion bugs without
 * standing up Postgres or the API.
 *
 *   npm run replay-payload -- path/to/report.json [--reporter <type>] [--pretty]
 *
 * The reporter is auto-detected from the filename when not given. No DB
 * connection, no auth — pure normalize().
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { normalize } from "../normalizers/index.js";
import type { NormalizedRun } from "../types.js";

const SUPPORTED = ["mochawesome", "junit", "playwright", "jest", "webdriverio"] as const;
type Reporter = (typeof SUPPORTED)[number];

/** Infer the reporter from a filename. Returns null when nothing matches. */
export function detectReporter(filePath: string): Reporter | null {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith(".xml") || name.includes("junit")) return "junit";
  if (name.includes("mochawesome") || name.includes("cypress")) return "mochawesome";
  if (name.includes("playwright")) return "playwright";
  if (name.includes("jest")) return "jest";
  if (name.includes("webdriverio") || name.includes("wdio")) return "webdriverio";
  return null;
}

/** Synthetic meta for an offline replay — the normalizer fills the rest. */
function replayMeta(filePath: string, reporter: Reporter): NormalizedRun["meta"] {
  return {
    suite_name: basename(filePath),
    branch: "",
    commit_sha: "",
    ci_run_id: "",
    started_at: "",
    finished_at: "",
    reporter,
  };
}

/**
 * Read a payload file and run it through the normalizer. Exported so tests can
 * drive the same path the CLI uses without spawning a process.
 */
export function replayPayload(filePath: string, reporterOverride?: string): NormalizedRun {
  const reporter = (reporterOverride as Reporter) ?? detectReporter(filePath);
  if (!reporter) {
    throw new Error(
      `Could not infer the reporter from "${basename(filePath)}". ` +
        `Pass --reporter <${SUPPORTED.join("|")}>.`,
    );
  }
  if (!SUPPORTED.includes(reporter)) {
    throw new Error(`Unsupported reporter: ${reporter}. Supported: ${SUPPORTED.join(", ")}`);
  }

  const text = readFileSync(filePath, "utf-8");
  // JUnit's parser takes the raw XML string; the JSON reporters take parsed JSON.
  let raw: unknown;
  if (reporter === "junit") {
    raw = text;
  } else {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse "${basename(filePath)}" as JSON: ${(err as Error).message}`);
    }
  }

  return normalize(reporter, raw, replayMeta(filePath, reporter));
}

interface ParsedArgs {
  filePath?: string;
  reporter?: string;
  pretty: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") out.pretty = true;
    else if (a === "--reporter") out.reporter = argv[++i];
    else if (a.startsWith("--reporter=")) out.reporter = a.slice("--reporter=".length);
    else if (!a.startsWith("--") && !out.filePath) out.filePath = a;
  }
  return out;
}

function main(): void {
  const { filePath, reporter, pretty } = parseArgs(process.argv.slice(2));
  if (!filePath) {
    console.error("Usage: npm run replay-payload -- <path> [--reporter <type>] [--pretty]");
    process.exit(1);
  }
  try {
    const run = replayPayload(filePath, reporter);
    process.stdout.write(JSON.stringify(run, null, pretty ? 2 : 0) + "\n");
    // Stats summary to stderr so stdout stays a clean machine-readable payload.
    const s = run.stats;
    console.error(
      `[replay] ${run.meta.reporter}: ${run.specs.length} spec(s), ${s.total} test(s) — ` +
        `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.pending} pending`,
    );
  } catch (err) {
    console.error(`[replay] ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run main() when invoked as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
