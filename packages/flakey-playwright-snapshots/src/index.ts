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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { gzipSync } from "zlib";
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

interface SnapshotStep {
  index: number;
  commandName: string;
  commandMessage: string;
  timestamp: number;
  html: string;
  scrollX: number;
  scrollY: number;
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

function cleanSelector(sel: string): string {
  // Convert internal selectors to readable form
  // internal:testid=[data-testid="email-input"s] → [data-testid="email-input"]
  return sel
    .replace(/internal:testid=\[([^\]]+)\]s?/g, "[$1]")
    .replace(/internal:role=([^[]+)\[/g, "role=$1[")
    .replace(/internal:text=["']([^"']+)["']/g, "text=$1");
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

  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name === "0-trace.trace" || (name.endsWith(".trace") && !name.includes("network") && !name.includes("stacks") && !name.startsWith("test"))) {
      traceData = entry.getData().toString("utf8");
    }
    if (name.startsWith("resources/") && (name.endsWith(".jpeg") || name.endsWith(".jpg") || name.endsWith(".png"))) {
      // Store by both the full path and just the filename (SHA1 references vary)
      const fileName = name.slice("resources/".length);
      resources.set(fileName, entry.getData());
      resources.set(name, entry.getData());
    }
  }

  if (!traceData) {
    return { commandLog: [], snapshotBundle: null };
  }

  // Parse trace lines
  const beforeActions = new Map<string, TraceAction>();
  const actions: { before: TraceAction; after: TraceAction | null }[] = [];

  for (const line of traceData.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj: any = JSON.parse(line);

      if (obj.type === "context-options" && obj.options?.viewport) {
        viewportWidth = obj.options.viewport.width ?? 1280;
        viewportHeight = obj.options.viewport.height ?? 720;
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

    if (closestFrame && resources.has(closestFrame.sha1)) {
      const imageData = resources.get(closestFrame.sha1)!;
      const base64 = imageData.toString("base64");
      const mimeType = closestFrame.sha1.endsWith(".png") ? "image/png" : "image/jpeg";

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

  const fileName = `${safeSpec}--${safeName}.json.gz`;
  const filePath = join(outputDir, fileName);

  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshotBundle)));
  writeFileSync(filePath, compressed);

  return { commandLog, snapshotPath: filePath };
}
