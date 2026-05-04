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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { tmpdir, homedir } from "os";
import { execSync } from "child_process";

// Buffer dirs scoped by the numeric live-run-id (written by live-reporter
// under every ancestor pid it can see). Both the plugin and the Mocha
// reporter walk their own ancestor chains to find a matching live-run-id
// file — the nearest shared ancestor wins (usually the cypress-CLI pid).
// Concurrent `cypress run` invocations have distinct cypress-CLI pids, so
// they never collide.
const FLAKEY_BASE_DIR = join(tmpdir(), "flakey-reporter");
const FLAKEY_CMD_BASE_DIR = join(tmpdir(), "flakey-commands");

function getAncestorPids(startPid: number, maxDepth = 12): number[] {
  const chain = [startPid];
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const ppid = Number(out);
      if (!ppid || ppid === 1 || ppid === pid) break;
      chain.push(ppid);
      pid = ppid;
    } catch {
      break;
    }
  }
  return chain;
}

function readLiveRunIdForPlugin(): number {
  const fromEnv = Number(process.env.FLAKEY_LIVE_RUN_ID);
  if (fromEnv) return fromEnv;
  for (const pid of getAncestorPids(process.pid)) {
    try {
      const id = Number(readFileSync(join(FLAKEY_BASE_DIR, `live-run-id-${pid}`), "utf8").trim());
      if (id) return id;
    } catch { /* try next */ }
  }
  // Singleton fallback — see reporter.ts for rationale. ~/.flakey-reporter/
  // is stable across all processes even when TMPDIR / cwd diverge.
  try {
    const id = Number(readFileSync(join(homedir(), ".flakey-reporter", "latest-run-id"), "utf8").trim());
    if (id) return id;
  } catch { /* try TMPDIR */ }
  try {
    const id = Number(readFileSync(join(FLAKEY_BASE_DIR, "latest-run-id"), "utf8").trim());
    if (id) return id;
  } catch { /* no singleton file */ }
  return 0;
}

function getBufferDirs() {
  const id = readLiveRunIdForPlugin();
  const suffix = id ? `run-${id}` : "";
  return {
    tmp: suffix ? join(FLAKEY_BASE_DIR, suffix) : FLAKEY_BASE_DIR,
    cmd: suffix ? join(FLAKEY_CMD_BASE_DIR, suffix) : FLAKEY_CMD_BASE_DIR,
    runId: id,
  };
}

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

interface FlakeyReporterOptions {
  url?: string;
  apiKey?: string;
  suite?: string;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
  release?: string;
  /**
   * Target environment label (e.g. "qa", "stage", "prod"). Recorded on
   * the run so the dashboard can filter by it. Falls back to
   * FLAKEY_ENV / TEST_ENV / cypress --env environment= / --env name=
   * if not provided here.
   */
  environment?: string;
  screenshotsDir?: string;
  videosDir?: string;
  snapshotsDir?: string;
  /**
   * When true (default), flakeyReporter installs its own `on("after:run")`
   * handler. When false (used by setupFlakey to chain live-reporter +
   * flakeyReporter in one combined handler), returns the after:run work
   * as a function the caller invokes. Needed because Cypress 15+ runs
   * only the LAST-registered handler per event — if live-reporter and
   * flakeyReporter both register, only one wins.
   */
  installAfterRun?: boolean;
}

export function flakeyReporter(
  on: any,
  config: any,
  options?: FlakeyReporterOptions
): ((results: any) => Promise<void>) | undefined {
  // Explicit options (third arg) take precedence over config.reporterOptions.
  // This is needed when the user wraps the Mocha reporter in something like
  // `cypress-multi-reporters`, which reshapes `config.reporterOptions` to
  // hold its own nested `*ReporterOptions` keys rather than the flat
  // {url, apiKey, suite} shape this plugin expects.
  // Merge explicit arg over config.reporterOptions so setupFlakey can pass
  // just `{ installAfterRun: false }` without clobbering the config-level
  // url/apiKey/suite.
  const opts = { ...(config.reporterOptions ?? {}), ...(options ?? {}) } as Record<string, string>;
  if (!opts?.url || !opts?.apiKey) {
    console.warn("  [flakey] Missing url or apiKey — pass them as the third arg to flakeyReporter(on, config, options) or set config.reporterOptions");
    return;
  }

  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const suite = opts.suite ?? "default";
  const branch = opts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "";
  const commitSha = opts.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "";
  // ciRunId is resolved LAZILY at upload time. live-reporter sets
  // process.env.CI_RUN_ID from before:run, which fires after setupNodeEvents,
  // so capturing it at registration would always see the stale/empty value.
  const resolveCiRunId = () =>
    opts.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "";
  const release = opts.release ?? process.env.FLAKEY_RELEASE ?? "";
  // Resolved at upload time — `cypress run --env environment=qa` (or
  // `--env name=qa`) is exposed on `config.env` and isn't available
  // until the user's setupNodeEvents has merged it in. Walk both keys
  // so the common Cypress conventions both work without ceremony.
  const cypressEnvBag = (config?.env ?? {}) as Record<string, unknown>;
  const cypressEnvironment =
    (typeof cypressEnvBag.environment === "string" && cypressEnvBag.environment) ||
    (typeof cypressEnvBag.name === "string" && cypressEnvBag.name) ||
    "";
  const resolveEnvironment = () =>
    (opts.environment ?? process.env.FLAKEY_ENV ?? process.env.TEST_ENV ?? cypressEnvironment ?? "").trim();
  const screenshotsDir = opts.screenshotsDir ?? "cypress/screenshots";
  const videosDir = opts.videosDir ?? "cypress/videos";
  const snapshotsDir = opts.snapshotsDir ?? "cypress/snapshots";

  // Register task for saving command logs from the support file
  on("task", {
    "flakey:saveCommandLog"(data: { testTitle: string; specFile: string; commands: object[] }) {
      const { cmd } = getBufferDirs();
      mkdirSync(cmd, { recursive: true });
      const safeName = `${data.specFile}::${data.testTitle}`.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 150);
      writeFileSync(join(cmd, `${safeName}.json`), JSON.stringify(data));
      return null;
    },
  });

  // Stream screenshots to the backend the moment Cypress finishes writing them
  // to disk, instead of waiting for the after:run batch. Mirrors the snapshot
  // plugin's pattern: on a 2xx response unlink the local file so screenshots
  // don't accumulate on the runner's disk over a long suite (the canonical
  // "CI pipeline ran out of space" failure mode). On a non-2xx or any throw,
  // leave the file in place so the after:run batch upload can still ship it.
  // The after:run batch's `findFiles` walks `screenshotsDir`, so a file that
  // was unlink'd successfully is naturally absent from the batch — no
  // separate Set is needed for dedup.
  on("after:screenshot", async (details: {
    path?: string;
    specName?: string;
    testFailure?: boolean;
    testTitle?: string | string[];
  }) => {
    const filePath = details?.path;
    if (!filePath || !existsSync(filePath)) return details;
    const runId = readLiveRunIdForPlugin();
    if (!runId) return details;

    const titleArr = Array.isArray(details.testTitle)
      ? details.testTitle
      : (details.testTitle ? [details.testTitle] : []);
    const fullTitle = titleArr.filter(Boolean).join(" > ");
    const specName = details.specName ?? "";
    if (!fullTitle || !specName) return details;

    try {
      const buf = readFileSync(filePath);
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);

      const form = new FormData();
      form.append("screenshot", new Blob([ab], { type: "image/png" }), basename(filePath));
      form.append("spec", specName);
      form.append("testTitle", fullTitle);

      const res = await fetch(`${url}/live/${runId}/screenshot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (res.ok) {
        try { unlinkSync(filePath); } catch { /* best-effort; batch upload tolerates duplicates */ }
      }
    } catch {
      // Streaming failed — leave file in place; after:run will still pick it up.
    }
    return details;
  });

  // (Intentionally no `before:run` here. Cypress 15+ runs ONLY the
  // last-registered handler per event; a no-op here would shadow
  // live-reporter's /live/start call. Cleanup of stale buffer dirs
  // happens in after:run instead.)

  // Collect all buffered specs and upload after the entire run
  const afterRunHandler = async (results: any) => {
    const { tmp: tmpDir, cmd: cmdDir } = getBufferDirs();
    if (!existsSync(tmpDir)) {
      console.warn("  [flakey] No spec results found — nothing to upload");
      return;
    }

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.warn("  [flakey] No spec results found — nothing to upload");
      return;
    }

    const specs: NormalizedSpec[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(tmpDir, file), "utf-8");
        specs.push(JSON.parse(content));
      } catch {}
    }

    // Merge command logs into test results
    if (existsSync(cmdDir)) {
      const cmdFiles = readdirSync(cmdDir).filter((f) => f.endsWith(".json"));
      const cmdMap = new Map<string, object[]>();
      for (const f of cmdFiles) {
        try {
          const data = JSON.parse(readFileSync(join(cmdDir, f), "utf-8"));
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
      rmSync(cmdDir, { recursive: true, force: true });
    }

    // Clean up temp files
    rmSync(tmpDir, { recursive: true, force: true });

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

    const environment = resolveEnvironment();
    const run = {
      meta: {
        suite_name: suite,
        branch,
        commit_sha: commitSha,
        ci_run_id: resolveCiRunId(),
        started_at: startedAt,
        finished_at: finishedAt,
        reporter: "cypress",
        ...(release ? { release } : {}),
        ...(environment ? { environment } : {}),
      },
      stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
      specs,
    };

    // Collect artifacts. Screenshots streamed via after:screenshot were
    // unlink'd on 2xx, so findFiles naturally returns only the screenshots
    // that didn't ship mid-run (streaming failure or no live run id).
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
  };

  if (options?.installAfterRun !== false) {
    on("after:run", afterRunHandler);
    return undefined;
  }
  return afterRunHandler;
}

interface SetupFlakeyOptions {
  snapshots?: boolean;
  live?: boolean;
  /**
   * Flakey reporter options (url, apiKey, suite, …). Pass these when your
   * cypress.config uses a wrapper like `cypress-multi-reporters` that
   * reshapes `config.reporterOptions` — without this, flakeyReporter can't
   * find url/apiKey in the wrapper's nested structure.
   */
  reporterOptions?: FlakeyReporterOptions;
}

export async function setupFlakey(
  on: any,
  config: any,
  opts: SetupFlakeyOptions = {}
): Promise<void> {
  // Cypress 15+ invokes ONLY the last-registered handler per event (Cypress
  // 13/14 chained all handlers in registration order). Both live-reporter
  // and flakeyReporter have critical after:run work, so we defer both and
  // chain them inside a single after:run handler we register at the end.
  let liveAfterRun: ((results: unknown) => Promise<void>) | undefined;
  if (opts.live !== false) {
    try {
      // @ts-ignore — optional peer dependency
      const { register } = await import("@flakeytesting/live-reporter/mocha");
      const fromReporterOpts = (config.reporterOptions ?? {}) as Record<string, string>;
      const url = opts.reporterOptions?.url ?? fromReporterOpts.url;
      const apiKey = opts.reporterOptions?.apiKey ?? fromReporterOpts.apiKey;
      const suite = opts.reporterOptions?.suite ?? fromReporterOpts.suite;
      const cypEnvBag = (config?.env ?? {}) as Record<string, unknown>;
      const cypEnv =
        (typeof cypEnvBag.environment === "string" && cypEnvBag.environment) ||
        (typeof cypEnvBag.name === "string" && cypEnvBag.name) ||
        "";
      const environment =
        opts.reporterOptions?.environment ?? fromReporterOpts.environment
          ?? process.env.FLAKEY_ENV ?? process.env.TEST_ENV ?? cypEnv;
      // installAfterRun was added in @flakeytesting/live-reporter 0.6.0; older
      // versions ignore it and install their own after:run (which collides on
      // Cypress 15 but is harmless on earlier versions).
      liveAfterRun = register(on, { url, apiKey, suite, environment, installAfterRun: false }) ?? undefined;
    } catch {
      // @flakeytesting/live-reporter not installed — skip
    }
  }

  if (opts.snapshots !== false) {
    try {
      // @ts-ignore — optional peer dependency
      const { flakeySnapshots } = await import("@flakeytesting/cypress-snapshots/plugin");
      flakeySnapshots(on, config);
    } catch {
      // @flakeytesting/cypress-snapshots not installed — skip
    }
  }

  const uploadAfterRun = flakeyReporter(on, config, {
    ...(opts.reporterOptions ?? {}),
    installAfterRun: false,
  } as FlakeyReporterOptions);

  on("after:run", async (results: any) => {
    // Live-reporter first: drains queued events, sends run.finished, releases
    // signal handlers, cleans up per-pid / latest-run-id handoff files.
    try { await liveAfterRun?.(results); } catch (err) { console.error("[flakey-live] after:run failed:", err); }
    // Then the main upload: collects spec buffers and POSTs /runs with
    // screenshots / videos / snapshots. Any throws here should not mask
    // the live-reporter teardown above.
    try { await uploadAfterRun?.(results); } catch (err) { console.error("[flakey] after:run failed:", err); }
  });
}
