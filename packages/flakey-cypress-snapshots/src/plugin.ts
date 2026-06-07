/**
 * Cypress plugin for DOM snapshot capture.
 * Register in cypress.config.ts:
 *
 *   import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";
 *   export default defineConfig({
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         flakeySnapshots(on, config);
 *       },
 *     },
 *   });
 */

import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { gzipSync } from "zlib";

interface SnapshotBundle {
  version: 1;
  testTitle: string;
  specFile: string;
  steps: {
    index: number;
    commandName: string;
    commandMessage: string;
    timestamp: number;
    html: string;
    scrollX: number;
    scrollY: number;
  }[];
  viewportWidth: number;
  viewportHeight: number;
  /** Number of step snapshots replaced with a placeholder (per-step cap). */
  cappedSteps?: number;
  /** Number of steps dropped FIFO to fit the aggregate bundle cap. */
  evictedSteps?: number;
}

interface FlakeySnapshotOptions {
  /** Output directory for snapshot files. Default: "cypress/snapshots" */
  outputDir?: string;
  /** Enable or disable snapshot capture. Default: true */
  enabled?: boolean;
  /**
   * Per-step HTML size cap in bytes. If a single snapshot's serialized DOM
   * exceeds this, it is replaced with a small placeholder. Protects against
   * pathological DOMs (e.g. PDF viewers) exploding the aggregate bundle past
   * V8's max string length when cy.task serializes it. Default: 2 MB.
   */
  maxHtmlBytes?: number;
  /**
   * Aggregate-bundle cap in bytes across all steps in one test. Oldest steps
   * are evicted FIFO once the running total exceeds this, which keeps the
   * gzipped-then-JSON-stringified bundle well under V8's max string length
   * even if every step is near `maxHtmlBytes`. Default: 64 MB.
   */
  maxBundleBytes?: number;
  /**
   * When true, prints `[flakey-snapshots] Streamed/Saved N steps → ...`
   * per saved bundle. Default false — quiet by design. Errors still
   * print. `FLAKEY_VERBOSE=1` env honoured as a fallback.
   */
  verbose?: boolean;
  /**
   * After a snapshot streams successfully to a live run, the local `.json.gz`
   * is deleted by default — a long suite that captures hundreds of snapshots
   * would otherwise fill the runner's disk before end-of-run. Set `false` to
   * KEEP the local file after a successful stream. Needed when `outputDir`
   * doubles as a persistent corpus that must survive live runs (e.g. a DOM
   * dump corpus consumed by a selector-reconcile tool). Default: true.
   */
  unlinkAfterStream?: boolean;
}

export function flakeySnapshots(
  on: any,
  config: any,
  options?: FlakeySnapshotOptions
): void {
  const outputDir = options?.outputDir ?? "cypress/snapshots";
  const enabled = options?.enabled ?? true;
  const maxHtmlBytes = options?.maxHtmlBytes ?? 2 * 1024 * 1024;
  const maxBundleBytes = options?.maxBundleBytes ?? 64 * 1024 * 1024;
  const verbose = options?.verbose === true || process.env.FLAKEY_VERBOSE === "1";
  const unlinkAfterStream = options?.unlinkAfterStream ?? true;

  // Signal to the support file whether snapshots are enabled
  config.env = config.env || {};
  config.env.FLAKEY_SNAPSHOTS_ENABLED = enabled;
  config.env.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES = maxHtmlBytes;
  config.env.FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES = maxBundleBytes;

  on("task", {
    async "flakey:saveSnapshot"(bundle: SnapshotBundle) {
      try {
        if (!bundle.steps || bundle.steps.length === 0) {
          return { saved: false, reason: "no steps" };
        }

        const safeName = bundle.testTitle
          .replace(/[^a-zA-Z0-9_\- ]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 100);

        const safeSpec = bundle.specFile
          .replace(/[^a-zA-Z0-9_\-./]/g, "")
          .replace(/\//g, "__");

        const fileName = `${safeSpec}--${safeName}.json.gz`;
        const filePath = join(outputDir, fileName);

        mkdirSync(dirname(filePath), { recursive: true });

        const json = JSON.stringify(bundle);
        const compressed = gzipSync(Buffer.from(json));
        writeFileSync(filePath, compressed);

        const capNote = formatCapNote(bundle);
        const streamed = await maybeStreamUpload(filePath, compressed, bundle);
        if (streamed) {
          // Keep the local file when the output dir is a persistent corpus
          // (unlinkAfterStream: false); otherwise reap it to bound disk use.
          if (unlinkAfterStream) {
            try { unlinkSync(filePath); } catch { /* ignore */ }
          }
          if (verbose) {
            console.log(
              `  [flakey-snapshots] Streamed ${bundle.steps.length} steps → ${fileName} (${(compressed.length / 1024).toFixed(1)}KB)${capNote}`
            );
          }
          return { saved: true, streamed: true, size: compressed.length };
        }

        if (verbose) {
          console.log(
            `  [flakey-snapshots] Saved ${bundle.steps.length} steps → ${fileName} (${(compressed.length / 1024).toFixed(1)}KB)${capNote}`
          );
        }

        return { saved: true, path: filePath, size: compressed.length };
      } catch (err) {
        console.error("  [flakey-snapshots] Failed to save snapshot:", err);
        return { saved: false, error: String(err) };
      }
    },
  });
}

function formatCapNote(bundle: SnapshotBundle): string {
  const capped = bundle.cappedSteps ?? 0;
  const evicted = bundle.evictedSteps ?? 0;
  if (capped === 0 && evicted === 0) return "";
  const parts: string[] = [];
  if (capped > 0) parts.push(`${capped} placeholder'd`);
  if (evicted > 0) parts.push(`${evicted} evicted`);
  return ` [${parts.join(", ")}]`;
}

async function maybeStreamUpload(
  filePath: string,
  compressed: Buffer,
  bundle: SnapshotBundle
): Promise<boolean> {
  const url = (process.env.FLAKEY_API_URL ?? "").replace(/\/$/, "");
  const apiKey = process.env.FLAKEY_API_KEY ?? "";
  const runId = Number(process.env.FLAKEY_LIVE_RUN_ID);
  if (!url || !apiKey || !runId) return false;

  try {
    const form = new FormData();
    const ab = new ArrayBuffer(compressed.byteLength);
    new Uint8Array(ab).set(compressed);
    form.append(
      "snapshot",
      new Blob([ab], { type: "application/gzip" }),
      filePath.split("/").pop() ?? "snapshot.json.gz"
    );
    form.append("spec", bundle.specFile);
    form.append("testTitle", bundle.testTitle);

    const res = await fetch(`${url}/live/${runId}/snapshot`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}
