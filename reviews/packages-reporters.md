# Reporter packages audit

Files reviewed: 20 source files across 4 packages (src/, CLAUDE.md, package.json, docs/).
No test files exist in any of the four packages.
Focus: docs vs reality, test coverage, CLAUDE.md quality.

---

## flakey-live-reporter

### High

#### H1. Double `before:run` overwrites `client` and orphans queued events

- **File**: `packages/flakey-live-reporter/src/mocha.ts:87-140`
- **Category**: bug
- **Problem**: The `startPromise` guard protects only the `/live/start` fetch. When Cypress 15+ fires `before:run` twice and `runId` is already set after the first call, the second invocation skips the `startPromise` block, reaches `client = new LiveClient(...)` unconditionally, and overwrites the existing client instance. Any events already queued in the first client are orphaned (never flushed). `teardownShutdown` is also overwritten, leaking the first signal handler.
- **Evidence**:
  ```ts
  // Second before:run call: !runId is false so startPromise block is skipped,
  // but execution falls through to here regardless:
  client = new LiveClient({ url, apiKey, runId }); // line 133
  client.send({ type: "run.started" });             // duplicate event
  teardownShutdown = installShutdownHandler(...);   // first handler leaked
  ```
- **Proposed change**:
  ```diff
  -    client = new LiveClient({ url, apiKey, runId });
  -    client.send({ type: "run.started" });
  -    teardownShutdown = installShutdownHandler(client, { ... });
  +    if (!client) {
  +      client = new LiveClient({ url, apiKey, runId });
  +      client.send({ type: "run.started" });
  +      teardownShutdown = installShutdownHandler(client, { ... });
  +    }
  ```
- **Risk if applied**: None — the guard is additive. `client` starts as `null`, so the first `before:run` sets it; subsequent calls are no-ops.
- **Verification**: Add a test that calls the `before:run` handler twice in quick succession with a pre-set `runId` and assert `LiveClient` is constructed exactly once and `run.started` is sent exactly once.

---

### Medium

#### M1. `FLAKEY_SUITE` env var is undocumented

- **File**: `packages/flakey-live-reporter/CLAUDE.md` (no env vars section)
- **Category**: inconsistency
- **Problem**: All three adapters fall back to `process.env.FLAKEY_SUITE` when `config.suite` is absent (`src/mocha.ts:70`, `src/playwright.ts:38`, `src/webdriverio.ts:38`). The CLAUDE.md mentions `FLAKEY_API_URL`, `FLAKEY_API_KEY`, `FLAKEY_LIVE_RUN_ID`, and `CI_RUN_ID` as outputs but omits `FLAKEY_SUITE` entirely as an input. A developer setting up CI environment variables will miss it.
- **Proposed change**: Add an env vars table to `CLAUDE.md`:
  ```markdown
  ## Env vars (inputs)

  | Var | Adapters | Notes |
  |-----|----------|-------|
  | `FLAKEY_API_URL` | all | Base URL; overridden by `config.url` |
  | `FLAKEY_API_KEY` | all | Auth token; overridden by `config.apiKey` |
  | `FLAKEY_SUITE` | all | Suite name fallback; overridden by `config.suite` |
  | `FLAKEY_LIVE_RUN_ID` | all | Pre-set run id; skips `/live/start` call |
  | `BRANCH` / `GITHUB_HEAD_REF` / `GITHUB_REF_NAME` | all | Branch fallback chain |
  | `COMMIT_SHA` / `GITHUB_SHA` | all | Commit SHA fallback chain |
  | `CI_RUN_ID` / `GITHUB_RUN_ID` | all | CI run id fallback; also written as output |
  ```
- **Risk if applied**: Documentation only.
- **Verification**: Read the updated CLAUDE.md and confirm every `process.env.*` reference in the three adapter source files is represented.

---

### Low

#### L1. No tests — concurrency logic has no automated coverage

- **File**: `packages/flakey-live-reporter/` (no test files)
- **Category**: dead-code / coverage drift
- **Problem**: The package has the most complex logic of the four (ancestor-walk PID resolution, `startPromise` guard, `installShutdownHandler`). None of it has tests. H1 above is a bug that tests would have caught.
- **Proposed change**: Add unit tests for at minimum: (a) `getAncestorPids` returns correct chain (mock `execSync`), (b) `register()` called with double `before:run` creates one `LiveClient` and sends one `run.started`, (c) `installShutdownHandler` teardown prevents abort after normal completion.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes in the package.

---

## flakey-cypress-reporter

### Medium

#### M2. `setupFlakey` is the consumer-facing entry point but is absent from CLAUDE.md

- **File**: `packages/flakey-cypress-reporter/CLAUDE.md` (Entry points section)
- **Category**: inconsistency
- **Problem**: The CLAUDE.md entry points section lists only `flakeyReporter`. The example integration (`examples/cypress/cypress.config.ts`) and every wiring snippet in the repo uses `setupFlakey` — the higher-level helper that composes `flakeyReporter`, optional snapshots, and optional live-reporter. A developer reading CLAUDE.md to understand the public API will wire up only `flakeyReporter` and miss the optional integrations.
- **Evidence**:
  ```ts
  // examples/cypress/cypress.config.ts
  import { setupFlakey } from "@flakeytesting/cypress-reporter/plugin";
  await setupFlakey(on, config);
  ```
  `setupFlakey` is exported from `dist/plugin.d.ts:40` but has no mention in CLAUDE.md.
- **Proposed change**: Add to the Entry points section:
  ```markdown
  Both `flakeyReporter` and `setupFlakey` are exported from `./plugin`.

  - `flakeyReporter(on, config, options?)` — registers upload hooks only.
  - `setupFlakey(on, config, opts?)` — composes `flakeyReporter` + optional `@flakeytesting/cypress-snapshots` + optional `@flakeytesting/live-reporter`. Prefer this in consumer configs.

  `SetupFlakeyOptions`: `{ snapshots?: boolean, live?: boolean, reporterOptions?: FlakeyReporterOptions }`
  ```
- **Risk if applied**: Documentation only.
- **Verification**: The CLAUDE.md entry points section matches the exported names in `dist/plugin.d.ts`.

#### M3. `plugin.ts` imports live-reporter via deep path instead of exports-map path

- **File**: `packages/flakey-cypress-reporter/src/plugin.ts:315`
- **Category**: inconsistency
- **Problem**: `setupFlakey` dynamically imports `@flakeytesting/live-reporter/dist/mocha.js` — a path that bypasses the package's exports map and relies on the internal dist layout. The canonical path is `@flakeytesting/live-reporter/mocha` per `live-reporter/package.json` exports. If the live-reporter dist structure changes, this silently breaks without a compile error.
- **Evidence**:
  ```ts
  const { register } = await import("@flakeytesting/live-reporter/dist/mocha.js");
  ```
- **Proposed change**:
  ```diff
  -const { register } = await import("@flakeytesting/live-reporter/dist/mocha.js");
  +const { register } = await import("@flakeytesting/live-reporter/mocha");
  ```
- **Risk if applied**: Functionally equivalent today (the `./dist/*` wildcard in live-reporter's exports map currently makes both paths resolve to the same file). Switch to the canonical path before any live-reporter refactor.
- **Verification**: `pnpm build` succeeds in `flakey-cypress-reporter`; the dynamic import resolves at runtime with a live-reporter installed.

---

### Low

#### L2. No tests

- **File**: `packages/flakey-cypress-reporter/` (no test files)
- **Category**: coverage drift
- **Problem**: `readLiveRunId()` (ancestor walk), `getBufferDir()` (run-id scoped path), `saveToTmp()`, and the command-log merge in `after:run` have no tests. These are the paths most likely to regress during Cypress version bumps.
- **Proposed change**: Add unit tests for `readLiveRunId` (mock `fs.readFileSync` and `execSync`), `getBufferDir` (assert path contains run-id), and the command-log key-matching logic.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes.

---

## flakey-playwright-reporter

### Medium

#### M4. CLAUDE.md claims fields the reporter does not capture

- **File**: `packages/flakey-playwright-reporter/CLAUDE.md:37`
- **Category**: inconsistency
- **Problem**: The CLAUDE.md states the reporter "captures retry history, tags, annotations, source location, stdout/stderr, and error snippets." The source (`src/reporter.ts`) captures only: `title`, `full_title`, `status`, `duration_ms`, `error.message`, `error.stack`, `screenshot_paths`, `video_path`, and (via trace) `command_log`. The `NormalizedTest` schema (`packages/flakey-core/src/schema.ts`) has no fields for retry count, tags, annotations, stdout, or stderr. The claim is entirely aspirational.
- **Evidence**:
  ```ts
  // src/reporter.ts — complete NormalizedTest construction, onTestEnd():
  const normalizedTest: NormalizedTest = {
    title: test.title,
    full_title: fullTitle,
    status,
    duration_ms: result.duration,
    screenshot_paths: screenshots,
    video_path: videos[0],
  };
  // No retry, tags, annotations, stdout, stderr.
  ```
- **Proposed change**: Replace the stale sentence with what is actually captured:
  ```markdown
  The reporter captures test title, full title path, pass/fail/skip status,
  duration, error message + stack, screenshot and video attachment paths, and
  (when traces are present) command logs extracted by `@flakeytesting/playwright-snapshots`.
  ```
- **Risk if applied**: Documentation only.
- **Verification**: Every field in the corrected description is present in `NormalizedTest` in `flakey-core/src/schema.ts`.

#### M5. CLAUDE.md references a README that does not exist

- **File**: `packages/flakey-playwright-reporter/CLAUDE.md:37`
- **Category**: inconsistency
- **Problem**: "see the README's 'Reporter Metadata' section" — there is no `README.md` in this package.
- **Proposed change**: Remove the parenthetical. After M4's fix, the sentence no longer needs a cross-reference.
- **Risk if applied**: None.
- **Verification**: No `README.md` exists; the sentence is gone.

---

### Low

#### L3. No tests

- **File**: `packages/flakey-playwright-reporter/` (no test files)
- **Category**: coverage drift
- **Problem**: `onTestEnd` status normalization (`timedOut` → `failed`, `interrupted` → `skipped`), trace parsing integration, and the snapshot-writing path in `onEnd` are untested.
- **Proposed change**: Add unit tests for the status normalization map and a test for `onEnd` that stubs `parseTrace` and asserts the snapshot file is written with the expected path convention.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes.

---

## flakey-webdriverio-reporter

### Low

#### L4. Default artifact directories differ from Cypress/Playwright and are undocumented

- **File**: `packages/flakey-webdriverio-reporter/src/reporter.ts:144-145`
- **Category**: inconsistency
- **Problem**: The WebdriverIO reporter defaults to `"screenshots"` and `"videos"` (relative paths), while the Cypress reporter defaults to `"cypress/screenshots"` and `"cypress/videos"`. The CLAUDE.md has no options table. Consumers who expect to configure these via the standard `screenshotsDir`/`videosDir` keys will find them undocumented.
- **Evidence**:
  ```ts
  const screenshotsDir = this.flakeyOpts.screenshotsDir ?? "screenshots";
  const videosDir      = this.flakeyOpts.videosDir      ?? "videos";
  ```
- **Proposed change**: Add an options table to CLAUDE.md:
  ```markdown
  ## Options

  | Option | Type | Default | Notes |
  |--------|------|---------|-------|
  | `url` | string | — | Required. Backend base URL. |
  | `apiKey` | string | — | Required. |
  | `suite` | string | — | Required. Suite name shown in dashboard. |
  | `branch` | string | env fallback | `BRANCH` → `GITHUB_REF_NAME` |
  | `commitSha` | string | env fallback | `COMMIT_SHA` → `GITHUB_SHA` |
  | `ciRunId` | string | env fallback | `CI_RUN_ID` → `GITHUB_RUN_ID` |
  | `screenshotsDir` | string | `"screenshots"` | Relative to cwd |
  | `videosDir` | string | `"videos"` | Relative to cwd |
  ```
- **Risk if applied**: Documentation only.
- **Verification**: Every key in `FlakeyWdioOptions` appears in the table.

#### L5. No tests

- **File**: `packages/flakey-webdriverio-reporter/` (no test files)
- **Category**: coverage drift
- **Problem**: Thin wrapper over `@wdio/reporter`; lower risk than live-reporter. Still, `onSuiteStart` spec-tracking and the artifact scan paths are untested.
- **Proposed change**: At minimum, test the `addTest` dispatch across `onTestPass`/`onTestFail`/`onTestSkip` and the `specMap` accumulation.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes.

---

## Clean sections (do not re-audit)

- **All four `package.json` files**: `main`, `exports`, and `files` entries point at files that exist in `dist/`. Peer dep declarations match CLAUDE.md. Versions are consistent at `0.5.0`.
- **`flakey-webdriverio-reporter` CLAUDE.md**: Consumer wiring snippet matches the actual constructor signature and `@wdio/reporter` extension pattern. Peer dep table is accurate.
- **`flakey-cypress-reporter` CLAUDE.md**: The ancestor-walk / process-tree / concurrency-safety documentation is accurate and complete. Buffer dir scoping explanation matches the code exactly.
- **`flakey-live-reporter` CLAUDE.md**: Side-effects of `register()` section accurately describes all three cross-package integration steps (env population, ancestor-walk write, startPromise guard). The `startPromise` description is correct for what it protects (only the HTTP call) — though H1 above is a separate gap the doc doesn't reveal.
- **`flakey-cypress-reporter/docs/cypress-background.md`**: Background-only context doc; no claims to verify against code.
- **`flakey-cypress-reporter/src/support.ts`**: Command log capture via `Cypress.on("log:added")` matches the `flakey:saveCommandLog` task in `plugin.ts`. Key construction (`specFile::testTitle`) is consistent on both sides.
