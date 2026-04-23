# Review: packages/flakey-{cypress,playwright,webdriverio}-reporter

## Scope
- Files reviewed: 28 (src/*.ts, package.json, CLAUDE.md, tsconfig.json for all three reporter packages + flakey-core + flakey-live-reporter + flakey-cypress-snapshots — all cross-referenced)
- Focus: bugs, misconfigurations, bad flows — consistency, upload correctness, lifecycle hooks, retry counting, CI env vars, artifact collection, dead code
- Reviewer confidence: high — all source files read in full; WDIO runtime behavior confirmed against installed @wdio/runner@9.27.0 in examples/webdriverio

Prior review at this path (dated yesterday) had 8 findings. All 8 are resolved in the current codebase (H1 double-before:run guard, M1 FLAKEY_SUITE docs, M2 setupFlakey docs, M3 deep import path, M4/M5 playwright CLAUDE.md, L4 WDIO options table). The findings below are entirely new.

---

## Priority: high

### H1. WDIO reporter: async `onRunnerEnd` is never awaited — upload is always dropped

- **File(s)**: `packages/flakey-webdriverio-reporter/src/reporter.ts:114-163`
- **Category**: bug
- **Problem**: `@wdio/reporter`'s base class calls `onRunnerEnd` synchronously (no `await`) and exposes an `isSynchronised` getter — defaulting to `true` — that `@wdio/runner` polls before allowing process exit. `FlakeyWdioReporter` overrides `onRunnerEnd` as `async` but never overrides `isSynchronised`. The result: `waitForSync()` resolves immediately (because `isSynchronised` is always `true`), the runner emits `exit`, the Node process tears down, and the `fetch()` inside `onRunnerEnd` is killed before it fires. Every single WDIO upload is silently dropped.
- **Evidence**:
  ```ts
  // @wdio/runner/build/index.js:886-897 (confirmed at
  // examples/webdriverio/node_modules/.pnpm/@wdio+runner@9.27.0_.../node_modules/@wdio/runner/build/index.js)
  this._reporter.emit("runner:end", { … });   // calls onRunnerEnd synchronously — no await
  try {
    await this._reporter.waitForSync();         // polls isSynchronised — resolves immediately
  } catch (err) { … }
  this.emit("exit", failures === 0 ? 0 : 1);  // process exits; fetch() is orphaned

  // packages/flakey-webdriverio-reporter/src/reporter.ts:114
  async onRunnerEnd(runner: RunnerStats) {
    // ...
    const result = await this.client.postRunWithFiles(run, { screenshots, videos, snapshots: [] });
    // ^^^ this await is never reached; process exits before onRunnerEnd resolves
  }
  ```
- **Proposed change**:
  ```diff
  export default class FlakeyWdioReporter extends WDIOReporter {
  +  private _synced = true;
  +
  +  get isSynchronised() {
  +    return this._synced;
  +  }

     async onRunnerEnd(runner: RunnerStats) {
  +    this._synced = false;
       const specs: NormalizedSpec[] = [];
       // ... rest of existing body unchanged ...
       try {
         const result = await this.client.postRunWithFiles(run, { screenshots, videos, snapshots: [] });
         console.log(`\n  [flakey] Uploaded run #${result.id} …`);
       } catch (err: any) {
         console.error(`\n  [flakey] Failed to upload: ${err.message}`);
  +    } finally {
  +      this._synced = true;
       }
     }
  ```
- **Risk if applied**: `isSynchronised` starts `true` and only turns `false` at the start of `onRunnerEnd`. If `onRunnerEnd` throws unexpectedly before the `finally`, the reporter will stall `waitForSync` until WDIO's `reporterSyncTimeout` (default 5 s). That is acceptable and prevents silent data loss.
- **Verification**: Run `npx wdio examples/webdriverio/wdio.conf.ts` with a valid backend URL and API key. Without the fix, no run record appears in the dashboard. With the fix, a run record appears.

---

### H2. Playwright and Cypress reporters inflate test counts when retries are configured

- **File(s)**: `packages/flakey-playwright-reporter/src/reporter.ts:53-134`, `packages/flakey-cypress-reporter/src/reporter.ts:175-288`
- **Category**: bug
- **Problem**: Both reporters append a new `NormalizedTest` entry to `spec.tests` on every test-end event, including non-final retry attempts. Playwright's `onTestEnd` fires once per attempt; Mocha's `fail`/`pass` events fire once per attempt. A test configured with `retries: 2` that passes on the third attempt produces three entries in `spec.tests` (two `failed`, one `passed`) and inflates `spec.stats.total` by 3 and `spec.stats.failed` by 2. On the backend this test appears as three separate results rather than one flaky result. The `PlaywrightTestResult` interface in the reporter does not even declare the `retry: number` field that Playwright provides, so there is no mechanism to filter non-final attempts.
- **Evidence**:
  ```ts
  // packages/flakey-playwright-reporter/src/reporter.ts:27-31
  interface PlaywrightTestResult {
    status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
    duration: number;
    error?: { message?: string; stack?: string };
    attachments: { name: string; path?: string; contentType: string }[];
    // retry: number is missing — Playwright does provide this field
  }

  // onTestEnd (line 53): no guard, always appends:
  entry.tests.push(normalizedTest);
  entry.spec.stats.total++;
  ```
- **Proposed change** (Playwright):
  ```diff
  interface PlaywrightTestCase {
    title: string;
    titlePath(): string[];
    location: { file: string; line: number; column: number };
    parent: { title: string; location?: { file: string } };
  +  retries: number;
  }

  interface PlaywrightTestResult {
    status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
    duration: number;
  +  retry: number;
    error?: { message?: string; stack?: string };
    attachments: { name: string; path?: string; contentType: string }[];
  }

  // In onTestEnd, add before the specMap append block:
  +  // Skip non-final retry attempts to avoid inflating counts.
  +  // result.retry is 0-based; test.retries is the configured max.
  +  if (result.status === "failed" && result.retry < test.retries) return;
  ```
  **Proposed change** (Cypress — Mocha reporter): Mocha exposes `test.currentRetry()` and `test.retries()`.
  ```diff
  // In addTest(), immediately after computing `duration`:
  +  const currentRetry = typeof (test as any).currentRetry === "function"
  +    ? (test as any).currentRetry() as number : 0;
  +  const maxRetries = typeof (test as any).retries === "function"
  +    ? (test as any).retries() as number : 0;
  +  if (status === "failed" && currentRetry < maxRetries) return;
  ```
- **Risk if applied**: Intermediate retry data (the failed attempts before the final pass) will no longer appear as individual test records. The trade-off is correct aggregate counts vs per-attempt detail. If per-attempt detail is wanted in the future, add a `retryAttempts` array field to `NormalizedTest` and populate it there.
- **Verification**: Configure a Playwright project with `retries: 2` and a deterministic test that fails twice then passes. Confirm the uploaded run record shows `stats.total: 1`, `stats.passed: 1`, `stats.failed: 0`.

---

## Priority: medium

### M1. Playwright `interrupted` test status silently mapped to `skipped`

- **File(s)**: `packages/flakey-playwright-reporter/src/reporter.ts:71-74`
- **Category**: bug
- **Problem**: Playwright sets `TestResult.status` to `"interrupted"` when a test is aborted mid-run (Ctrl-C, worker crash, global timeout). The reporter's status normalizer maps anything that is not `"passed"`, `"failed"`, or `"timedOut"` to `"skipped"`. An interrupted test that consumed real time and may have an error object lands in the dashboard as skipped, hiding CI failures.
- **Evidence**:
  ```ts
  // packages/flakey-playwright-reporter/src/reporter.ts:71-74
  const status: NormalizedTest["status"] =
    result.status === "passed" ? "passed" :
    result.status === "failed" || result.status === "timedOut" ? "failed" :
    "skipped";  // "interrupted" falls here — wrong
  ```
- **Proposed change**:
  ```diff
  -    result.status === "failed" || result.status === "timedOut" ? "failed" :
  +    result.status === "failed" || result.status === "timedOut" || result.status === "interrupted" ? "failed" :
       "skipped";
  ```
- **Risk if applied**: Interrupted tests will increment `stats.failed`. This is correct semantics.
- **Verification**: Kill a Playwright worker process mid-test (or use `globalTimeout`). Confirm the interrupted test appears as `failed` in the uploaded run record, not `skipped`.

---

### M2. Bitbucket Pipelines env vars missing from Playwright, WDIO, and live-reporter adapters

- **File(s)**: `packages/flakey-playwright-reporter/src/reporter.ts:188-190`, `packages/flakey-webdriverio-reporter/src/reporter.ts:133-135`, `packages/flakey-live-reporter/src/mocha.ts:113-116`, `packages/flakey-live-reporter/src/playwright.ts:57-59`, `packages/flakey-live-reporter/src/webdriverio.ts:55-57`
- **Category**: inconsistency
- **Problem**: The Cypress plugin reads `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`, and `BITBUCKET_BUILD_NUMBER` as env var fallbacks for `branch`, `commit_sha`, and `ci_run_id`. No other reporter or live-reporter adapter reads any Bitbucket var. On Bitbucket Pipelines, Playwright and WDIO users get empty `branch`, `commit_sha`, and `ci_run_id` on every run unless they manually configure the options — and the live run also has no branch metadata even for Cypress users.
- **Evidence**:
  ```ts
  // packages/flakey-cypress-reporter/src/plugin.ts:158-164 — has BITBUCKET_*:
  const branch = opts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "";
  const commitSha = ... ?? process.env.BITBUCKET_COMMIT ?? "";
  const resolveCiRunId = () => ... ?? process.env.BITBUCKET_BUILD_NUMBER ?? "";

  // packages/flakey-playwright-reporter/src/reporter.ts:188-190 — no BITBUCKET_*:
  branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
  commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
  ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
  ```
- **Proposed change**: Add the three Bitbucket vars at the end of the fallback chain in all five locations listed above:
  ```diff
  -  branch: ... ?? process.env.GITHUB_REF_NAME ?? "",
  +  branch: ... ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
  -  commit_sha: ... ?? process.env.GITHUB_SHA ?? "",
  +  commit_sha: ... ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
  -  ci_run_id: ... ?? process.env.GITHUB_RUN_ID ?? "",
  +  ci_run_id: ... ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
  ```
  Apply identically to all five source locations. The `BITBUCKET_BUILD_NUMBER` var in the live-reporter adapters needs the same lazy-resolution treatment as the Cypress plugin uses for `ciRunId` — evaluate at call time, not at constructor time — but the other two (`BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`) are safe to read at construction.
- **Risk if applied**: None — the vars only activate on Bitbucket Pipelines where they are set.
- **Verification**: Set `BITBUCKET_BRANCH=main BITBUCKET_COMMIT=abc123 BITBUCKET_BUILD_NUMBER=42` in the environment before running Playwright. Confirm `meta.branch`, `meta.commit_sha`, and `meta.ci_run_id` are populated in the uploaded run.

---

### M3. `ApiClient.postRunWithArtifacts` is dead code and creates a maintenance trap

- **File(s)**: `packages/flakey-core/src/api-client.ts:32-80`
- **Category**: dead-code
- **Problem**: `postRunWithArtifacts` is defined in `ApiClient` but called by no reporter, no CLI, and no test (confirmed by `grep -r postRunWithArtifacts packages/` returning only the definition). Both active reporters use `postRunWithFiles`. The method also duplicates the artifact-scan logic that each reporter already owns. If a future contributor reaches for this method, they will encounter a subtly different calling convention: it takes directory paths instead of pre-collected file lists, introducing divergence from the established pattern.
- **Evidence**:
  ```ts
  // packages/flakey-core/src/api-client.ts:32 — defined but never called:
  async postRunWithArtifacts(
    run: NormalizedRun,
    opts: { screenshotsDir?: string; snapshotsDir?: string; videosDir?: string }
  ): Promise<{ id: number }> { … }
  ```
- **Proposed change**: Delete `postRunWithArtifacts` (lines 32–80) and the private `findFiles` function (lines 124–146) from `api-client.ts`. Neither is exported from `flakey-core/src/index.ts`.
  ```diff
  -  async postRunWithArtifacts(
  -    run: NormalizedRun,
  -    opts: { screenshotsDir?: string; snapshotsDir?: string; videosDir?: string }
  -  ): Promise<{ id: number }> {
  -    // ... entire 48-line body ...
  -  }
  -
  -function findFiles(dir: string | undefined, exts: string[]): string[] {
  -  // ... entire 23-line body ...
  -}
  ```
- **Risk if applied**: None — the function is unreachable. The `findFiles` used by `plugin.ts` and `webdriverio/reporter.ts` are their own local copies; removing the one in `api-client.ts` does not affect them.
- **Verification**: `grep -r postRunWithArtifacts packages/` returns no results after deletion. `pnpm build` succeeds in all three reporter packages and `flakey-core`.

---

### M4. `dist/mocha.js.bak` is tracked in git and ships in the npm tarball

- **File(s)**: `packages/flakey-live-reporter/dist/mocha.js.bak`
- **Category**: dead-code
- **Problem**: A `.bak` file (202 lines, 10 KB) is committed to `dist/` of `flakey-live-reporter` (confirmed: `git ls-files` returns it). The `package.json` `"files": ["dist"]` includes the entire directory without exclusions, so it will be bundled into every npm publish of `@flakeytesting/live-reporter`. It is not imported or referenced by any code path.
- **Evidence**:
  ```
  $ git ls-files packages/flakey-live-reporter/dist/mocha.js.bak
  packages/flakey-live-reporter/dist/mocha.js.bak   # tracked in git
  ```
- **Proposed change**:
  ```diff
  # Remove from git:
  git rm packages/flakey-live-reporter/dist/mocha.js.bak
  ```
  Create `packages/flakey-live-reporter/.npmignore` with `dist/*.bak` to prevent recurrence.
- **Risk if applied**: None.
- **Verification**: After the commit, `git ls-files packages/flakey-live-reporter/dist/` does not list `mocha.js.bak`. Running `npm pack --dry-run` from `packages/flakey-live-reporter/` does not include `mocha.js.bak` in the file list.

---

## Priority: low

### L1. `reporter.ts` imports four `fs` symbols that are never used

- **File(s)**: `packages/flakey-cypress-reporter/src/reporter.ts:21`
- **Category**: dead-code
- **Problem**: The source imports `readdirSync`, `statSync`, `existsSync`, and `rmSync` from `"fs"`. None of these are called in `reporter.ts`. TypeScript elides them from the build output (the installed `dist/reporter.js` and `dist/reporter.cjs` import only `writeFileSync`, `mkdirSync`, and `readFileSync`), but the source-level dead imports suggest directory-scanning or cleanup logic that was moved to `plugin.ts` during refactoring and was not cleaned up.
- **Evidence**:
  ```ts
  // packages/flakey-cypress-reporter/src/reporter.ts:21
  import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "fs";
  //                                                ^^^^^^^^^^^  ^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^ — never used
  ```
- **Proposed change**:
  ```diff
  -import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "fs";
  +import { writeFileSync, mkdirSync, readFileSync } from "fs";
  ```
- **Risk if applied**: None. TypeScript strict mode would catch any accidental removal of a used symbol.
- **Verification**: `pnpm build` in `flakey-cypress-reporter` succeeds without errors. `dist/reporter.cjs` header still shows only `const{writeFileSync,mkdirSync,readFileSync}=require("fs")`.

---

### L2. No upload timeout on any `fetch()` call across all reporters

- **File(s)**: `packages/flakey-cypress-reporter/src/plugin.ts:271-292`, `packages/flakey-core/src/api-client.ts:15-29`, `packages/flakey-core/src/api-client.ts:68-79`, `packages/flakey-core/src/api-client.ts:109-120`
- **Category**: bug
- **Problem**: Every `fetch()` that uploads run data — the Cypress plugin's inline `afterRunHandler`, `ApiClient.postRun`, and `ApiClient.postRunWithFiles` — passes no `signal`. If the backend is unreachable or stalls mid-response, the reporter hangs indefinitely and stalls the CI pipeline.
- **Evidence**:
  ```ts
  // packages/flakey-core/src/api-client.ts:15
  const res = await fetch(`${this.url}/runs`, {
    method: "POST",
    headers: { … },
    body: JSON.stringify(run),
    // no signal, no timeout
  });
  ```
- **Proposed change**: Add `AbortSignal.timeout()` to every upload `fetch()`. Use 30 s for JSON-only calls and 120 s for multipart form uploads (videos can be large).
  ```diff
  // ApiClient.postRun (api-client.ts:15):
   const res = await fetch(`${this.url}/runs`, {
     method: "POST",
     headers: { … },
     body: JSON.stringify(run),
  +  signal: AbortSignal.timeout(30_000),
   });

  // ApiClient.postRunWithFiles (api-client.ts:109) and Cypress plugin (plugin.ts:285):
   const res = await fetch(`${this.url}/runs/upload`, {
     method: "POST",
     headers: { Authorization: `Bearer ${this.apiKey}` },
     body: formData,
  +  signal: AbortSignal.timeout(120_000),
   });
  ```
  `AbortSignal.timeout()` is available in Node ≥ 17.3 and all supported browsers. The workspace targets ES2020 / Node 18+.
- **Risk if applied**: CI jobs that currently hang indefinitely on network failures will now fail with a `TimeoutError` after 30–120 s. This is the correct behavior.
- **Verification**: Point `url` at an unresponsive address (`http://10.255.255.1`) and run a Playwright test. Confirm the reporter logs `[flakey] Failed to upload: …TimeoutError…` within the configured timeout rather than hanging until the CI job is killed.
