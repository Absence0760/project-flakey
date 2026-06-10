/**
 * Extracts command logs and screencast frames from Playwright trace.zip files.
 * Produces a SnapshotBundle compatible with Flakey's SnapshotViewer.
 *
 * The trace contains:
 * - Action entries (before/after pairs) with method, selector, params, errors
 * - Screencast frames (JPEG images) timestamped during execution
 *
 * We match each action to the closest screencast frame to create a step-by-step
 * visual replay similar to Cypress DOM snapshots.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";
import { createHash } from "crypto";
import AdmZip from "adm-zip";

interface TraceAction {
  callId: string;
  type: "before" | "after";
  class?: string;
  method?: string;
  params?: Record<string, any>;
  startTime?: number;
  endTime?: number;
  error?: { name?: string; message?: string };
  stepId?: string;
  pageId?: string;
}

interface ScreencastFrame {
  sha1: string;
  timestamp: number;
  width: number;
  height: number;
}

interface CommandEntry {
  name: string;
  message: string;
  state: "passed" | "failed";
}

// Per-step runtime context (Phase 1 enrichment). Both arrays are OPTIONAL so
// pre-enrichment bundles — and steps with nothing to show — stay unchanged;
// the SnapshotViewer renders them only when present.
interface ConsoleLogEntry {
  // Normalized level: log | info | warn | error | debug. Playwright emits
  // "warning"; we fold it to "warn" so the consumer's level styling is uniform.
  level: string;
  text: string;
}

interface NetworkLogEntry {
  method: string;
  url: string;
  status?: number;
}

interface SnapshotStep {
  index: number;
  commandName: string;
  commandMessage: string;
  timestamp: number;
  html: string;
  scrollX: number;
  scrollY: number;
  console?: ConsoleLogEntry[];
  network?: NetworkLogEntry[];
}

interface SnapshotBundle {
  version: 1;
  testTitle: string;
  specFile: string;
  steps: SnapshotStep[];
  viewportWidth: number;
  viewportHeight: number;
}

interface ParseResult {
  commandLog: CommandEntry[];
  snapshotBundle: SnapshotBundle | null;
}

const ACTION_CLASSES = new Set(["Frame", "Page", "Locator", "ElementHandle", "JSHandle"]);

// Per-step caps on attached context, mirroring the byte/line discipline in
// @flakeytesting/cypress-snapshots. A chatty page (polling XHR, console spam)
// must not bloat the bundle past what the upload can serialize.
const MAX_CONSOLE_PER_STEP = 100;
const MAX_NETWORK_PER_STEP = 50;

// Playwright console message types → the normalized level the viewer styles by.
function normalizeConsoleLevel(t: string): string {
  if (t === "warning") return "warn";
  if (t === "error" || t === "warn" || t === "info" || t === "debug" || t === "log") return t;
  return "log";
}

// Exported for unit testing (src/tests/parse-trace.test.ts).
export function cleanSelector(sel: string): string {
  // Convert Playwright's internal selector engine syntax to readable form.
  // The trailing `s` / `i` after a value is the match-mode flag Playwright
  // appends (strict / case-insensitive) — strip it.
  //   internal:testid=[data-testid="email-input"]s → [data-testid="email-input"]
  //   internal:role=button[name="x"]               → role=button[name="x"]
  //   internal:role=button                         → role=button
  //   internal:text="it's done"s                   → text=it's done
  //   internal:text='quote " inside'               → text=quote " inside
  // The value captures are length-bounded ({0,N}) rather than unbounded
  // (`+`/`*`): an unbounded negated class before a failable terminator is a
  // polynomial-ReDoS shape (O(n²)) under the global flag, and `sel` comes from
  // a parsed (untrusted) Playwright trace. No real selector value approaches
  // this cap, so matching is unchanged for legitimate input.
  return sel
    .replace(/internal:testid=\[([^\]]{1,1000})\]s?/g, "[$1]")
    // Strip the prefix only — keep any trailing `[name=…]` AND match the bare
    // `getByRole("button")` form with no bracket at all (the old `([^[]+)\[`
    // required a `[`, so a bracket-less role kept the `internal:` prefix).
    .replace(/internal:role=/g, "role=")
    // Separate the double- and single-quoted forms so the capture's stop char
    // is the *opposite* quote — `[^"']` (the old form) stopped at either, so
    // `getByText("it's done")` truncated at the apostrophe to `text=it`. Each
    // form also strips the trailing strict/case-insensitive flag letter.
    .replace(/internal:text="([^"]{0,1000})"[a-z]?/g, "text=$1")
    .replace(/internal:text='([^']{0,1000})'[a-z]?/g, "text=$1");
}

function formatAction(method: string, params: Record<string, any>): { name: string; message: string } {
  const sel = params.selector ? cleanSelector(params.selector) : "";
  const url = params.url ?? "";
  const val = params.value ?? "";
  const key = params.key ?? "";
  const expr = params.expression ?? "";
  const expected = params.expectedText?.[0]?.string ?? params.expectedValue ?? "";

  let message = "";
  if (method === "goto") message = url;
  else if (method === "fill") message = sel ? `${sel} → "${val}"` : val;
  else if (method === "press") message = sel ? `${sel} → ${key}` : key;
  else if (method === "click") message = sel;
  else if (method === "expect") message = sel ? `${sel} ${expr} "${expected}"` : `${expr} "${expected}"`;
  else if (sel) message = sel;

  return { name: method, message };
}

/**
 * Parse a Playwright trace.zip and extract command log + snapshot bundle.
 */
export function parseTrace(
  tracePath: string,
  testTitle: string,
  specFile: string
): ParseResult {
  if (!existsSync(tracePath)) {
    return { commandLog: [], snapshotBundle: null };
  }

  const zip = new AdmZip(tracePath);

  // Find the library trace file (0-trace.trace has the actual page actions)
  let traceData = "";
  let screencastFrames: ScreencastFrame[] = [];
  const resources = new Map<string, Buffer>();
  let viewportWidth = 1280;
  let viewportHeight = 720;

  // Collect candidate library traces, then pick deterministically below.
  // (The library trace holds the page actions; network/stacks/test-* traces
  // are excluded.)
  const traceCandidates = new Map<string, Buffer>();
  // Network entries live in a SEPARATE file from the action trace — the very
  // file the candidate filter below excludes. Collect it here. The name has
  // varied across Playwright versions ("trace.network" in 1.59; older builds
  // used "*-network.trace"), so accept both shapes rather than one literal.
  const networkData: string[] = [];
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name.endsWith(".network") || (name.endsWith(".trace") && name.includes("network"))) {
      networkData.push(entry.getData().toString("utf8"));
    }
    if (name.endsWith(".trace") && !name.includes("network") && !name.includes("stacks") && !name.startsWith("test")) {
      traceCandidates.set(name, entry.getData());
    }
    if (name.startsWith("resources/") && (name.endsWith(".jpeg") || name.endsWith(".jpg") || name.endsWith(".png"))) {
      // Store by both the full path and just the filename (SHA1 references vary)
      const fileName = name.slice("resources/".length);
      resources.set(fileName, entry.getData());
      resources.set(name, entry.getData());
    }
  }

  // Prefer the canonical 0-trace.trace; otherwise take the lowest-sorted match
  // so a zip with multiple library traces resolves deterministically instead
  // of by zip iteration order (which is what "last write wins" gave us before).
  const traceName = traceCandidates.has("0-trace.trace")
    ? "0-trace.trace"
    : [...traceCandidates.keys()].sort()[0];
  if (traceName) {
    traceData = traceCandidates.get(traceName)!.toString("utf8");
  }

  if (!traceData) {
    return { commandLog: [], snapshotBundle: null };
  }

  // Parse trace lines
  const beforeActions = new Map<string, TraceAction>();
  const actions: { before: TraceAction; after: TraceAction | null }[] = [];
  // Console events live inline in the action trace; network events in the
  // separate file collected above. Both carry a monotonic `time` on the same
  // clock as action start/end times, so we can bucket each to the active step.
  const consoleEvents: { time: number; level: string; text: string }[] = [];

  for (const line of traceData.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj: any = JSON.parse(line);

      if (obj.type === "context-options" && obj.options?.viewport) {
        viewportWidth = obj.options.viewport.width ?? 1280;
        viewportHeight = obj.options.viewport.height ?? 720;
      }

      if (obj.type === "console") {
        consoleEvents.push({
          time: typeof obj.time === "number" ? obj.time : 0,
          level: normalizeConsoleLevel(typeof obj.messageType === "string" ? obj.messageType : "log"),
          text: typeof obj.text === "string" ? obj.text : "",
        });
      }

      if (obj.type === "screencastFrame" || obj.type === "screencast-frame") {
        screencastFrames.push({
          sha1: obj.sha1,
          timestamp: obj.timestamp,
          width: obj.width,
          height: obj.height,
        });
      }

      if (obj.type === "before" && obj.class && ACTION_CLASSES.has(obj.class)) {
        beforeActions.set(obj.callId, obj);
      }

      if (obj.type === "after" && beforeActions.has(obj.callId)) {
        const before = beforeActions.get(obj.callId)!;
        actions.push({ before, after: obj });
        beforeActions.delete(obj.callId);
      }
    } catch {}
  }

  // Sort screencast frames by timestamp
  screencastFrames.sort((a, b) => a.timestamp - b.timestamp);

  // Build command log and snapshot steps
  const commandLog: CommandEntry[] = [];
  const steps: SnapshotStep[] = [];
  const startTime = actions[0]?.before.startTime ?? 0;

  for (let i = 0; i < actions.length; i++) {
    const { before, after } = actions[i];
    const method = before.method ?? "";
    const params = before.params ?? {};
    const hasFailed = !!after?.error;

    const { name, message } = formatAction(method, params);

    commandLog.push({
      name,
      message,
      state: hasFailed ? "failed" : "passed",
    });

    // Find the closest screencast frame to this action's end time
    const actionTime = after?.endTime ?? before.startTime ?? 0;
    let closestFrame: ScreencastFrame | null = null;
    let closestDist = Infinity;

    for (const frame of screencastFrames) {
      const dist = Math.abs(frame.timestamp - actionTime);
      if (dist < closestDist) {
        closestDist = dist;
        closestFrame = frame;
      }
    }

    // Trace screencast frames reference resources by bare sha1 hash (no extension).
    // Resources are stored under "<sha1>.jpeg" / "<sha1>.png" keys — try each.
    const sha1 = closestFrame?.sha1 ?? "";
    const resourceKey = resources.has(sha1 + ".jpeg") ? sha1 + ".jpeg"
      : resources.has(sha1 + ".png") ? sha1 + ".png"
      : resources.has(sha1) ? sha1
      : null;
    if (closestFrame && resourceKey) {
      const imageData = resources.get(resourceKey)!;
      const base64 = imageData.toString("base64");
      const mimeType = resourceKey.endsWith(".png") ? "image/png" : "image/jpeg";

      steps.push({
        index: i,
        commandName: name,
        commandMessage: message,
        timestamp: Math.round((actionTime - startTime) * 1000),
        html: `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 0; overflow: hidden; background: #000; }
  img { width: 100%; height: 100%; object-fit: contain; }
</style></head><body>
<img src="data:${mimeType};base64,${base64}" alt="Step ${i + 1}: ${name} ${message}" />
</body></html>`,
        scrollX: 0,
        scrollY: 0,
      });
    }
  }

  // Parse network events from the separate network file(s).
  const networkEvents: { time: number; method: string; url: string; status?: number }[] = [];
  for (const data of networkData) {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj: any = JSON.parse(line);
        if (obj.type !== "resource-snapshot") continue;
        const snap = obj.snapshot ?? {};
        const url = typeof snap.request?.url === "string" ? snap.request.url : "";
        if (!url) continue;
        const status = typeof snap.response?.status === "number" && snap.response.status >= 0
          ? snap.response.status : undefined;
        networkEvents.push({
          time: typeof snap._monotonicTime === "number" ? snap._monotonicTime : 0,
          method: typeof snap.request?.method === "string" ? snap.request.method : "",
          url,
          status,
        });
      } catch {}
    }
  }

  // Attach console + network to the step that was active when each occurred.
  // "Active step" = the latest step whose action had started by the event's
  // time; events before the first step fall to step 0. Steps are a subset of
  // actions (only those that matched a screencast frame), so bucket against the
  // steps' own start times — and DON'T assume they're time-sorted (actions are
  // recorded in completion order), so scan for the last match rather than
  // breaking early.
  if (steps.length > 0 && (consoleEvents.length > 0 || networkEvents.length > 0)) {
    const stepStarts = steps.map((s) => actions[s.index]?.before.startTime ?? 0);
    const stepForTime = (t: number): number => {
      let idx = 0;
      for (let p = 0; p < stepStarts.length; p++) {
        if (stepStarts[p] <= t) idx = p;
      }
      return idx;
    };
    for (const ev of consoleEvents) {
      const step = steps[stepForTime(ev.time)];
      (step.console ??= []);
      if (step.console.length < MAX_CONSOLE_PER_STEP) step.console.push({ level: ev.level, text: ev.text });
    }
    for (const ev of networkEvents) {
      const step = steps[stepForTime(ev.time)];
      (step.network ??= []);
      if (step.network.length < MAX_NETWORK_PER_STEP) {
        step.network.push(ev.status !== undefined
          ? { method: ev.method, url: ev.url, status: ev.status }
          : { method: ev.method, url: ev.url });
      }
    }
  }

  const snapshotBundle: SnapshotBundle | null = steps.length > 0 ? {
    version: 1,
    testTitle,
    specFile,
    steps,
    viewportWidth,
    viewportHeight,
  } : null;

  return { commandLog, snapshotBundle };
}

/**
 * Parse a trace and save the snapshot bundle as a gzipped JSON file.
 * Returns the path to the saved file, or null if no data.
 */
export function parseAndSaveTrace(
  tracePath: string,
  testTitle: string,
  specFile: string,
  outputDir: string
): { commandLog: CommandEntry[]; snapshotPath: string | null } {
  const { commandLog, snapshotBundle } = parseTrace(tracePath, testTitle, specFile);

  if (!snapshotBundle || snapshotBundle.steps.length === 0) {
    return { commandLog, snapshotPath: null };
  }

  mkdirSync(outputDir, { recursive: true });

  const safeName = testTitle
    .replace(/[^a-zA-Z0-9_\- ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 100);

  const safeSpec = specFile
    .replace(/[^a-zA-Z0-9_\-./]/g, "")
    .replace(/\//g, "__");

  // Hash the raw (pre-sanitization) spec::title identity and append a short
  // suffix. Without it, two DISTINCT tests whose titles sanitize to the same
  // name (e.g. "Login: works!" and "Login  works", or a parameterized test and
  // its sibling) write to the same path and the second silently clobbers the
  // first — losing a whole test's snapshots. The hash is stable for a given
  // test, so its own retries still resolve to one file (last-write-wins, which
  // is intended). Mirrors the @flakeytesting/cypress-snapshots plugin.
  const hash = createHash("sha1").update(`${specFile}::${testTitle}`).digest("hex").slice(0, 8);
  const fileName = `${safeSpec}--${safeName}-${hash}.json.gz`;
  const filePath = join(outputDir, fileName);

  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshotBundle)));
  writeFileSync(filePath, compressed);

  return { commandLog, snapshotPath: filePath };
}
