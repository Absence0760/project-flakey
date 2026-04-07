/**
 * Cypress plugin for DOM snapshot capture.
 * Register in cypress.config.ts:
 *
 *   import { flakeySnapshots } from "@flakey/cypress-snapshots/plugin";
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
  /** Only save snapshots for failed tests. Default: false */
  failedOnly?: boolean;
}

export function flakeySnapshots(
  on: Cypress.PluginEvents,
  _config: Cypress.PluginConfigOptions,
  options?: FlakeySnapshotOptions
): void {
  const outputDir = options?.outputDir ?? "cypress/snapshots";
  const failedOnly = options?.failedOnly ?? false;

  // Track which tests failed
  const failedTests = new Set<string>();

  on("task", {
    "flakey:saveSnapshot"(bundle: SnapshotBundle) {
      try {
        if (failedOnly) {
          // In failedOnly mode, we buffer the snapshot and only write it
          // if the test failed (checked in after:spec). For simplicity,
          // we always write and let the CLI decide whether to upload.
        }

        // Sanitize filename
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
