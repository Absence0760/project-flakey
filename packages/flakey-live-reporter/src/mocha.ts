/**
 * Mocha/Cypress live reporter — streams test events during execution.
 *
 * Usage with Cypress:
 *   // cypress.config.ts
 *   setupNodeEvents(on) {
 *     require('@flakeytesting/live-reporter/mocha').register(on, {
 *       url: 'http://localhost:3000',
 *       apiKey: 'fk_...',
 *       suite: 'my-suite',
 *     });
 *   }
 *
 * The reporter automatically creates a placeholder run via POST /live/start
 * so the run appears in the dashboard immediately. The main reporter's upload
 * at the end merges into this run via ci_run_id.
 *
 * Env vars: FLAKEY_API_URL, FLAKEY_API_KEY, FLAKEY_LIVE_RUN_ID (optional override)
 */

import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { execSync } from "child_process";
import { LiveClient, installShutdownHandler } from "./index.js";

const FLAKEY_BASE_DIR = join(tmpdir(), "flakey-reporter");
// Home-dir fallback for the singleton handoff file. tmpdir() isn't reliable
// across Cypress 15's process tree (different subprocesses resolve different
// TMPDIR env vars); homedir() is. cwd() would also work but process.cwd()
// in the Mocha reporter subprocess is NOT guaranteed to match the cypress
// invocation dir in Cypress 15.
const FLAKEY_HOME_DIR = join(homedir(), ".flakey-reporter");

// Walk the current process's ancestor chain (self → parent → parent's parent
// → …). The Mocha reporter (running in a different process tree branch than
// setupNodeEvents in some Cypress versions, e.g. 15+) walks its own chain
// and reads `live-run-id-<pid>` for each ancestor until it finds a match.
// Writing one file per ancestor gives the reporter a stable handoff point:
// usually the cypress-CLI pid is a common ancestor of both processes.
// Concurrent `cypress run` invocations have distinct cypress-CLI pids so
// their writes never collide.
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

interface MochaLiveConfig {
  url?: string;
  apiKey?: string;
  suite?: string;
  runId?: number;
  branch?: string;
  commitSha?: string;
  ciRunId?: string;
  /**
   * Target environment label (e.g. "qa", "stage", "prod"). Falls back to
   * FLAKEY_ENV / TEST_ENV process env vars when omitted.
   */
  environment?: string;
  /**
   * When true, prints `[flakey-live] Live run started: #N` and
   * `[flakey-live] Run #N complete — N passed` to stdout. Default
   * false — keeps CI logs quiet by design; errors still print.
   * `FLAKEY_VERBOSE=1` in the environment is honoured as a fallback.
   */
  verbose?: boolean;
  /**
   * When true (default), register() installs its own `on("after:run", ...)`
   * handler. When false (used by setupFlakey to work around Cypress 15's
   * "only last after:run handler runs" behavior), register() skips that
   * registration and returns a teardown function the caller invokes inside
   * a combined after:run handler.
   */
  installAfterRun?: boolean;
}

export function register(
  on: (event: string, handler: (...args: any[]) => void) => void,
  config: MochaLiveConfig = {},
  // Optional Cypress `config` object from setupNodeEvents — when
  // present, lets the environment-resolution chain see Cypress's own
  // conventions (`cypress run --env name=qa` lands at config.env.name;
  // `--env environment=qa` lands at config.env.environment). Without
  // this, a consumer wiring this adapter directly (not via setupFlakey)
  // would silently drop the environment label that the Cypress
  // ecosystem expects to work. setupFlakey in flakey-cypress-reporter
  // already pre-resolves these and passes them via `config.environment`
  // — this parameter only matters for direct callers.
  cypressConfig?: { env?: Record<string, unknown> }
): ((results: unknown) => Promise<void>) | undefined {
  const url = (config.url ?? process.env.FLAKEY_API_URL ?? "").replace(/\/$/, "");
  const apiKey = config.apiKey ?? process.env.FLAKEY_API_KEY ?? "";
  const suite = config.suite ?? process.env.FLAKEY_SUITE ?? "";

  // Cypress `--env name=` and `--env environment=` conventions for
  // labelling the run's target environment. Walked AFTER FLAKEY_ENV /
  // TEST_ENV because an explicit env var should win over a Cypress
  // CLI flag that might also be set for another tool's benefit.
  const cypressEnv = cypressConfig?.env ?? {};
  const cypressEnvironment =
    (typeof cypressEnv.environment === "string" && cypressEnv.environment) ||
    (typeof cypressEnv.name === "string" && cypressEnv.name) ||
    "";

  if (!url || !apiKey) return;

  // Default-off success log. FLAKEY_VERBOSE=1 env override keeps the
  // CI flow toggleable without code changes.
  const verbose = config.verbose === true || process.env.FLAKEY_VERBOSE === "1";

  // Make credentials visible to sibling plugins (e.g. cypress-snapshots streaming).
  process.env.FLAKEY_API_URL = url;
  process.env.FLAKEY_API_KEY = apiKey;

  let client: LiveClient | null = null;
  let teardownShutdown: (() => void) | null = null;
  let runId = config.runId ?? (Number(process.env.FLAKEY_LIVE_RUN_ID) || 0);

  // Guard the /live/start call behind a shared promise so concurrent
  // before:run handler invocations (Cypress 15+ fires before:run twice
  // in some configurations) don't each create a separate placeholder run.
  let startPromise: Promise<void> | null = null;

  on("before:run", async () => {
    if (!runId && suite) {
      if (!startPromise) {
        startPromise = (async () => {
          try {
            const res = await fetch(`${url}/live/start`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                suite,
                branch: config.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
                commitSha: config.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
                ciRunId: config.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
                environment: config.environment ?? process.env.FLAKEY_ENV ?? process.env.TEST_ENV ?? cypressEnvironment,
              }),
            });
            if (res.ok) {
              const data = await res.json() as { id: number; ci_run_id: string };
              runId = data.id;
              if (data.ci_run_id) {
                process.env.CI_RUN_ID = data.ci_run_id;
              }
              process.env.FLAKEY_LIVE_RUN_ID = String(runId);
              try {
                mkdirSync(FLAKEY_BASE_DIR, { recursive: true });
                // Write one run-id file per ancestor pid so the Mocha reporter
                // (which may live in a different process tree branch) can find
                // a match by walking its own ancestor chain.
                for (const pid of getAncestorPids(process.pid)) {
                  writeFileSync(join(FLAKEY_BASE_DIR, `live-run-id-${pid}`), String(runId));
                }
                // Singleton fallback — some Cypress versions (observed in 15.14)
                // put the Mocha reporter in a process tree that shares NO
                // ancestor with setupNodeEvents. The ancestor walk returns no
                // matches and the reporter can't locate the buffer dir.
                // TMPDIR isn't reliable either (Cypress 15 child processes can
                // inherit a DIFFERENT os.tmpdir() than the plugin), so write
                // a `.flakey-live-run-id` file in cwd — which IS stable across
                // the Cypress process tree. Both plugin and Mocha reporter
                // resolve cwd to the invocation dir.
                writeFileSync(join(FLAKEY_BASE_DIR, "latest-run-id"), String(runId));
                // Home-dir singleton — works even when TMPDIR and cwd diverge
                // across Cypress's process tree. This is the fallback the
                // Mocha reporter relies on in Cypress 15+.
                try {
                  mkdirSync(FLAKEY_HOME_DIR, { recursive: true });
                  writeFileSync(join(FLAKEY_HOME_DIR, "latest-run-id"), String(runId));
                } catch { /* ignore — the tmpdir path may still work */ }
              } catch { /* ignore */ }
              if (verbose) {
                console.log(`[flakey-live] Live run started: #${runId} (ci_run_id: ${data.ci_run_id})`);
              }
            }
          } catch (err) {
            console.error("[flakey-live] Failed to start live run:", err);
          }
        })();
      }
      await startPromise;
    }

    if (!runId) return;

    // Guard against Cypress 15+ firing before:run twice. On the second call
    // runId is already set (skipped the startPromise block above) but client
    // was already constructed on the first call — skip to avoid orphaning
    // queued events and leaking signal handlers.
    if (!client) {
      client = new LiveClient({ url, apiKey, runId });
      client.send({ type: "run.started" });
      // Ctrl-C / SIGTERM before after:run fires → tell the backend immediately
      // so the LIVE badge clears instead of waiting for the stale timeout.
      teardownShutdown = installShutdownHandler(client, {
        reason: "Cypress process received a shutdown signal.",
      });
    }
  });

  on("before:spec", (spec: { relative: string }) => {
    client?.send({ type: "spec.started", spec: spec.relative });
  });

  on("after:spec", (spec: { relative: string }, results: { stats: { passes: number; failures: number; skipped: number; pending?: number; tests: number } }) => {
    // Individual test.passed/failed/skipped events are sent in real-time by the
    // Flakey Cypress reporter (reporter.ts) as each test finishes. Here we only
    // emit the spec-level summary so the live feed shows spec completion markers.
    //
    // Cypress's Mocha runner reports `it.skip()` / `xit()` tests as
    // `pending`, NOT `skipped`. The backend's recompute path bundles
    // both into the "skipped" bucket; mirror that here so the
    // mid-run spec.finished payload doesn't disagree with the
    // backend's eventual count if the spec has any pending tests.
    client?.send({
      type: "spec.finished",
      spec: spec.relative,
      stats: {
        total: results.stats.tests,
        passed: results.stats.passes,
        failed: results.stats.failures,
        skipped: results.stats.skipped + (results.stats.pending ?? 0),
      },
    });
  });

  const afterRunHandler = async (results: { totalFailed?: number; totalPassed?: number; totalTests?: number } | undefined) => {
    client?.send({ type: "run.finished" });
    await client?.flush();
    client?.stop();
    // Normal exit path — release the signal handlers so an unrelated SIGTERM
    // later in the process lifecycle doesn't spuriously abort a finished run.
    teardownShutdown?.();
    teardownShutdown = null;
    for (const pid of getAncestorPids(process.pid)) {
      try { unlinkSync(join(FLAKEY_BASE_DIR, `live-run-id-${pid}`)); } catch { /* ignore */ }
    }
    try { unlinkSync(join(FLAKEY_BASE_DIR, "latest-run-id")); } catch { /* ignore */ }
    try { unlinkSync(join(FLAKEY_HOME_DIR, "latest-run-id")); } catch { /* ignore */ }
    if (runId && verbose) {
      const failed = results?.totalFailed ?? 0;
      const passed = results?.totalPassed ?? 0;
      const total = results?.totalTests ?? 0;
      const status = failed > 0 ? `${failed} failed, ${passed} passed` : `${total} passed`;
      console.log(`[flakey-live] Run #${runId} complete — ${status}`);
    }
  };

  if (config.installAfterRun !== false) {
    on("after:run", afterRunHandler);
    return undefined;
  }
  // Caller (setupFlakey) will invoke the handler inside a combined
  // after:run registration — Cypress 15 only runs the LAST-registered
  // handler per event, so we can't have live-reporter and flakeyReporter
  // each install their own.
  return afterRunHandler as (results: unknown) => Promise<void>;
}
