/**
 * Cypress plugin for Flakey reporter.
 * Collects buffered spec results and uploads once after the entire run.
 *
 * cypress.config.ts:
 *   import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin";
 *   export default defineConfig({
 *     reporter: "@flakeytesting/cypress-reporter",
 *     reporterOptions: { url, apiKey, suite },
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         flakeyReporter(on, config);
 *       },
 *     },
 *   });
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

const FLAKEY_TMP_DIR = join(tmpdir(), "flakey-reporter");
const FLAKEY_CMD_DIR = join(tmpdir(), "flakey-commands");

interface NormalizedSpec {
  file_path: string;
  title: string;
  stats: { total: number; passed: number; failed: number; skipped: number; duration_ms: number };
  tests: {
    title: string;
    full_title: string;
    status: string;
    duration_ms: number;
    error?: { message: string; stack?: string };
    screenshot_paths: string[];
    video_path?: string;
    command_log?: object[];
  }[];
}

function findFiles(dir: string | undefined, exts: string[]): string[] {
  if (!dir || !existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (exts.some((ext) => entry.endsWith(ext))) results.push(full);
      } catch {}
    }
  }
  walk(dir);
  return results;
}

export function flakeyReporter(
  on: any,
  config: any
): void {
  const opts = config.reporterOptions as Record<string, string> | undefined;
  if (!opts?.url || !opts?.apiKey) {
    console.warn("  [flakey] Missing url or apiKey in reporterOptions — skipping upload");
    return;
  }

  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const suite = opts.suite ?? "default";
  const branch = opts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "";
  const commitSha = opts.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "";
  const ciRunId = opts.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "";
  const screenshotsDir = opts.screenshotsDir ?? "cypress/screenshots";
  const videosDir = opts.videosDir ?? "cypress/videos";
  const snapshotsDir = opts.snapshotsDir ?? "cypress/snapshots";

  // Register task for saving command logs from the support file
  on("task", {
    "flakey:saveCommandLog"(data: { testTitle: string; specFile: string; commands: object[] }) {
      mkdirSync(FLAKEY_CMD_DIR, { recursive: true });
      const safeName = `${data.specFile}::${data.testTitle}`.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 150);
      writeFileSync(join(FLAKEY_CMD_DIR, `${safeName}.json`), JSON.stringify(data));
      return null;
    },
  });

  // Clean up temp dirs before run starts
  on("before:run", () => {
    if (existsSync(FLAKEY_TMP_DIR)) {
      rmSync(FLAKEY_TMP_DIR, { recursive: true, force: true });
    }
    if (existsSync(FLAKEY_CMD_DIR)) {
      rmSync(FLAKEY_CMD_DIR, { recursive: true, force: true });
    }
  });

  // Collect all buffered specs and upload after the entire run
  on("after:run", async (results: any) => {
    if (!existsSync(FLAKEY_TMP_DIR)) {
      console.warn("  [flakey] No spec results found — nothing to upload");
      return;
    }

    const files = readdirSync(FLAKEY_TMP_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.warn("  [flakey] No spec results found — nothing to upload");
      return;
    }

    const specs: NormalizedSpec[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(FLAKEY_TMP_DIR, file), "utf-8");
        specs.push(JSON.parse(content));
      } catch {}
    }

    // Merge command logs into test results
    if (existsSync(FLAKEY_CMD_DIR)) {
      const cmdFiles = readdirSync(FLAKEY_CMD_DIR).filter((f) => f.endsWith(".json"));
      const cmdMap = new Map<string, object[]>();
      for (const f of cmdFiles) {
        try {
          const data = JSON.parse(readFileSync(join(FLAKEY_CMD_DIR, f), "utf-8"));
          cmdMap.set(`${data.specFile}::${data.testTitle}`, data.commands);
        } catch {}
      }
      for (const spec of specs) {
        for (const test of spec.tests) {
          const key = `${spec.file_path}::${test.title}`;
          const cmds = cmdMap.get(key);
          if (cmds) test.command_log = cmds;
        }
      }
      rmSync(FLAKEY_CMD_DIR, { recursive: true, force: true });
    }

    // Clean up temp files
    rmSync(FLAKEY_TMP_DIR, { recursive: true, force: true });

    if (specs.length === 0) return;

    let total = 0, passed = 0, failed = 0, skipped = 0, duration = 0;
    for (const spec of specs) {
      total += spec.stats.total;
      passed += spec.stats.passed;
      failed += spec.stats.failed;
      skipped += spec.stats.skipped;
      duration += spec.stats.duration_ms;
    }

    const startedAt = (results as any)?.startedTestsAt ?? new Date().toISOString();
    const finishedAt = (results as any)?.endedTestsAt ?? new Date().toISOString();

    const run = {
      meta: {
        suite_name: suite,
        branch,
        commit_sha: commitSha,
        ci_run_id: ciRunId,
        started_at: startedAt,
        finished_at: finishedAt,
        reporter: "cypress",
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    // Collect artifacts
    const screenshots = findFiles(screenshotsDir, [".png"]);
    const videos = findFiles(videosDir, [".mp4", ".webm"]);
    const snapshots = findFiles(snapshotsDir, [".json.gz"]);

    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };

    try {
      let res: Response;

      if (screenshots.length === 0 && videos.length === 0 && snapshots.length === 0) {
        res = await fetch(`${url}/runs`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(run),
        });
      } else {
        const formData = new FormData();
        formData.append("payload", JSON.stringify(run));

        for (const file of screenshots) {
          formData.append("screenshots", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
        }
        for (const file of videos) {
          const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
          formData.append("videos", new Blob([readFileSync(file)], { type }), basename(file));
        }
        for (const file of snapshots) {
          formData.append("snapshots", new Blob([readFileSync(file)], { type: "application/gzip" }), basename(file));
        }

        res = await fetch(`${url}/runs/upload`, { method: "POST", headers, body: formData });
      }

      if (!res.ok) {
        const text = await res.text();
        console.error(`\n  [flakey] Upload failed (${res.status}): ${text}`);
        return;
      }

      const result = await res.json() as { id: number };
      console.log(`\n  [flakey] Uploaded run #${result.id} (${total} tests, ${failed} failed) → ${url}`);
    } catch (err: any) {
      console.error(`\n  [flakey] Failed to upload: ${err.message}`);
    }
  });
}
