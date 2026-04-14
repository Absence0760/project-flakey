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

import { writeFileSync, mkdirSync } from "fs";
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
}

interface FlakeySnapshotOptions {
  /** Output directory for snapshot files. Default: "cypress/snapshots" */
  outputDir?: string;
  /** Enable or disable snapshot capture. Default: true */
  enabled?: boolean;
}

export function flakeySnapshots(
  on: any,
  config: any,
  options?: FlakeySnapshotOptions
): void {
  const outputDir = options?.outputDir ?? "cypress/snapshots";
  const enabled = options?.enabled ?? true;

  // Signal to the support file whether snapshots are enabled
  config.env = config.env || {};
  config.env.FLAKEY_SNAPSHOTS_ENABLED = enabled;

  on("task", {
    "flakey:saveSnapshot"(bundle: SnapshotBundle) {
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

        console.log(
          `  [flakey-snapshots] Saved ${bundle.steps.length} steps → ${fileName} (${(compressed.length / 1024).toFixed(1)}KB)`
        );

        return { saved: true, path: filePath, size: compressed.length };
      } catch (err) {
        console.error("  [flakey-snapshots] Failed to save snapshot:", err);
        return { saved: false, error: String(err) };
      }
    },
  });
}
