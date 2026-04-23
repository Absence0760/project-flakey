# Review: packages/flakey-core, flakey-cli, flakey-mcp-server, flakey-live-reporter, flakey-cypress-snapshots, flakey-playwright-snapshots

## Scope
- Files reviewed: 54 (all source, config, and stub files across the 6 target packages plus cross-referenced flakey-cypress-reporter, flakey-playwright-reporter, flakey-webdriverio-reporter, and the backend uploads route)
- Focus: bugs, misconfigurations, bad flows — public surface, cross-package drift, lifecycle hooks, data collection, CLI UX, MCP, snapshot plugins, rebrand dead code
- Reviewer confidence: high — every in-scope file read in full; cross-referenced backend upload handler, adjacent reporter packages, and all inter-package call sites

---

## Priority: high

### H1. CLI top-level dispatch does not await async subcommands — unhandled rejection on any pre-`process.exit` throw
- **File(s)**: `packages/flakey-cli/src/index.ts:377-391`
- **Category**: bug
- **Problem**: All five async subcommand functions (`upload`, `uploadCoverage`, `uploadA11y`, `uploadVisual`, `uploadUiCoverage`) are called without `await` at the top-level switch. Each function internalizes errors with `try/catch` + `process.exit(1)`, so the happy-path mostly works, but any exception thrown before the inner `try` block (e.g. a JSON parse error, or a future early `throw`) becomes an unhandled rejection. On Node 15+, unhandled rejections print a raw stack trace and exit with code 1 — bypassing the user-readable `console.error` messages the functions intend to show.
- **Evidence**:
  ```ts
  // index.ts:376-391
  switch (sub) {
    case "coverage":
      uploadCoverage(rest);   // no await, no .catch()
      break;
    case "a11y":
      uploadA11y(rest);
      break;
    // ...
    case null:
      upload(parseArgs());    // same
      break;
  }
  ```
- **Proposed change**: Wrap the entire dispatch in an async IIFE with a top-level catch:
  ```diff
  - const argv = process.argv.slice(2);
  - const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  - const rest = sub ? argv.slice(1) : argv;
  -
  - switch (sub) {
  -   case "coverage":
  -     uploadCoverage(rest);
  -     break;
  -   case "a11y":
  -     uploadA11y(rest);
  -     break;
  -   case "visual":
  -     uploadVisual(rest);
  -     break;
  -   case "ui-coverage":
  -     uploadUiCoverage(rest);
  -     break;
  -   case "upload":
  -   case null:
  -     upload(parseArgs());
  -     break;
  -   default:
  -     console.error(`Unknown subcommand: ${sub}`);
  -     console.error("Available: upload, coverage, a11y, visual, ui-coverage");
  -     process.exit(1);
  - }
  + (async () => {
  +   const argv = process.argv.slice(2);
  +   const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  +   const rest = sub ? argv.slice(1) : argv;
  +
  +   switch (sub) {
  +     case "coverage":   await uploadCoverage(rest);   break;
  +     case "a11y":       await uploadA11y(rest);       break;
  +     case "visual":     await uploadVisual(rest);     break;
  +     case "ui-coverage": await uploadUiCoverage(rest); break;
  +     case "upload":
  +     case null:         await upload(parseArgs());    break;
  +     default:
  +       console.error(`Unknown subcommand: ${sub}`);
  +       console.error("Available: upload, coverage, a11y, visual, ui-coverage");
  +       process.exit(1);
  +   }
  + })().catch((err) => {
  +   console.error(`flakey-upload: unexpected error — ${err.message}`);
  +   process.exit(1);
  + });
  ```
- **Risk if applied**: None — pure control-flow change, same observable behavior on all existing code paths.
- **Verification**: Add a test: monkey-patch `fetch` to throw before the try block in `uploadCoverage`, run `flakey-upload coverage --run-id 1 --file /dev/null`, confirm exit code is 1 and output is a user-readable message (not a `UnhandledPromiseRejection` stack).

---

### H2. Playwright-reporter and WebdriverIO-reporter record the wrong branch name on GitHub Actions pull requests
- **File(s)**: `packages/flakey-playwright-reporter/src/reporter.ts:188`, `packages/flakey-webdriverio-reporter/src/reporter.ts:133`
- **Category**: bug
- **Problem**: On GitHub Actions pull-request runs, `GITHUB_REF_NAME` is `"<pr-number>/merge"` (the synthetic merge ref), not the feature branch name. `GITHUB_HEAD_REF` contains the actual branch name on PRs. Both reporter packages omit `GITHUB_HEAD_REF` from their fallback chain, so every Playwright and WebdriverIO run uploaded from a PR shows `"42/merge"` as the branch in the dashboard instead of the developer's feature branch. The live-reporter adapters for the same frameworks already include `GITHUB_HEAD_REF` (correct), creating a split: the live placeholder run shows the wrong branch but correct live events, while the final `/runs` upload persists the wrong branch permanently.
- **Evidence**:
  ```ts
  // playwright-reporter/src/reporter.ts:188 — GITHUB_HEAD_REF absent
  branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",

  // live-reporter/src/playwright.ts:57 — GITHUB_HEAD_REF present (correct)
  branch: this.config.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "",
  ```
- **Proposed change**:
  ```diff
  // packages/flakey-playwright-reporter/src/reporter.ts:188
  -       branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
  +       branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "",

  // packages/flakey-webdriverio-reporter/src/reporter.ts:133
  -       branch: this.flakeyOpts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
  +       branch: this.flakeyOpts.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? "",
  ```
- **Risk if applied**: None. On non-PR runs `GITHUB_HEAD_REF` is empty and the existing `GITHUB_REF_NAME` (now third in chain) is used as before.
- **Verification**: In a GitHub Actions PR workflow, set only `GITHUB_HEAD_REF=feature/my-branch` and `GITHUB_REF_NAME=42/merge`, run the reporter, confirm the uploaded run's `meta.branch` is `"feature/my-branch"`.

---

### H3. CLI `findFiles` throws on broken symlinks — crashes upload instead of skipping
- **File(s)**: `packages/flakey-cli/src/index.ts:83`
- **Category**: bug
- **Problem**: The CLI's `findFiles` function calls `statSync(full)` with no try/catch. A broken symlink (target deleted, common in CI artifact directories) throws `ENOENT`. The exception is unhandled in the walk and propagates to `upload()`, crashing the entire upload with an unrelated error message. All other `findFiles` implementations in this repo (`flakey-core/api-client.ts:131-139`, `flakey-cypress-reporter/plugin.ts:100-111`) have a `try/catch` around the `statSync` call.
- **Evidence**:
  ```ts
  // packages/flakey-cli/src/index.ts:82-84 — no guard
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);   // throws on broken symlink
  ```
  Compare to `flakey-core/src/api-client.ts:131`:
  ```ts
  try {
    const stat = statSync(full);
    ...
  } catch {
    // Skip inaccessible files
  }
  ```
- **Proposed change**:
  ```diff
  // packages/flakey-cli/src/index.ts:82-92
   function walk(d: string) {
     for (const entry of readdirSync(d)) {
       const full = join(d, entry);
  -    const stat = statSync(full);
  -    if (stat.isDirectory()) {
  -      walk(full);
  -    } else if (entry.endsWith(ext)) {
  -      results.push(full);
  -    }
  +    try {
  +      const stat = statSync(full);
  +      if (stat.isDirectory()) {
  +        walk(full);
  +      } else if (entry.endsWith(ext)) {
  +        results.push(full);
  +      }
  +    } catch {
  +      // Skip inaccessible entries (broken symlinks, permission errors)
  +    }
     }
   }
  ```
- **Risk if applied**: A broken symlink that happened to point to a real artifact would be silently skipped. This is acceptable — a broken symlink cannot be read or uploaded anyway.
- **Verification**: Create a symlink pointing to a non-existent file inside a temp screenshots dir, run `flakey-upload --screenshots-dir <tmpdir> --suite x --report-dir <valid-reports-dir>`, confirm the process completes without crashing (either uploads or exits cleanly).

---

## Priority: medium

### M1. `postRunWithArtifacts` in `flakey-core` is dead code with a different payload shape — a caller would silently corrupt uploads
- **File(s)**: `packages/flakey-core/src/api-client.ts:32-80`
- **Category**: dead-code / bug
- **Problem**: `postRunWithArtifacts` exists in the public `ApiClient` but is called nowhere in the codebase (confirmed: zero call sites). It is also the only one of the three upload methods that wraps the payload differently — `JSON.stringify({meta: run.meta, stats: run.stats, specs: run.specs})` — which happens to be identical to `JSON.stringify(run)` structurally, so it would not error, but the discrepancy is a maintenance hazard: a future `NormalizedRun` field added at the top level would be silently dropped. The method should either be removed or unified with `postRunWithFiles`.
- **Evidence**:
  ```ts
  // api-client.ts:46-49
  formData.append("payload", JSON.stringify({
    meta: run.meta,
    stats: run.stats,
    specs: run.specs,               // explicit fields — misses any future top-level key
  }));

  // api-client.ts:93
  formData.append("payload", JSON.stringify(run)); // correct — sends the whole run
  ```
  ```bash
  # Zero callers:
  grep -rn "postRunWithArtifacts" packages/ --include="*.ts" | grep -v dist | grep -v "api-client.ts"
  # (no output)
  ```
- **Proposed change**: Delete `postRunWithArtifacts` entirely from `packages/flakey-core/src/api-client.ts` lines 32–80. It is exported so bump `@flakeytesting/core` to 0.6.0 with a semver-minor "removed dead method" note.
- **Risk if applied**: Any external consumer calling `postRunWithArtifacts` would get a compile-time error after upgrading. Given this is a relatively new OSS package, that risk is low, and the method was never documented or tested.
- **Verification**: `grep -rn "postRunWithArtifacts" packages/` returns no matches after deletion.

---

### M2. No `"types"` field in any published package — consumers on `moduleResolution: node` (Webpack 4, Jest default, older TS) get no types
- **File(s)**: `packages/flakey-core/package.json`, `packages/flakey-live-reporter/package.json`, `packages/flakey-playwright-snapshots/package.json`, `packages/flakey-cypress-snapshots/package.json`, `packages/flakey-cypress-reporter/package.json`, `packages/flakey-playwright-reporter/package.json`, `packages/flakey-webdriverio-reporter/package.json`
- **Category**: misconfiguration
- **Problem**: None of the published packages have a `"types"` field. With `"exports"` + `"type": "module"`, TypeScript 5 using `moduleResolution: bundler` or `node16` resolves types from the co-located `.d.ts` files and works fine. But consumers on `moduleResolution: node` (the TypeScript default for `"module": "commonjs"` projects; also the effective resolution used by Jest, Webpack 4, ts-node without `--esm`) ignore the `"exports"` map entirely and fall back to `"main"` + an implicit `.d.ts` substitution. For most packages that path still works (e.g. `"main": "dist/index.js"` → `dist/index.d.ts`), but for `flakey-cypress-reporter` it does not: `"main": "dist/reporter.cjs"` → TS looks for `dist/reporter.d.cts` (does not exist), then gives up. The package appears untyped to any consumer using the classic resolver.
- **Evidence**:
  ```json
  // packages/flakey-core/package.json — representative; all 7 packages identical
  {
    "type": "module",
    "main": "dist/index.js",
    // "types": field absent
    "exports": { ".": "./dist/index.js" }
  }

  // packages/flakey-cypress-reporter/package.json
  {
    "main": "dist/reporter.cjs",
    // no "types" field → TS node resolution looks for dist/reporter.d.cts — missing
  }
  ```
- **Proposed change**: Add a `"types"` field to each package pointing at the primary declaration file. Apply the rule: `"types"` = the `.d.ts` that corresponds to `"main"`.
  ```diff
  // flakey-core/package.json
  + "types": "dist/index.d.ts",

  // flakey-live-reporter/package.json
  + "types": "dist/index.d.ts",

  // flakey-playwright-snapshots/package.json
  + "types": "dist/index.d.ts",

  // flakey-playwright-reporter/package.json
  + "types": "dist/reporter.d.ts",

  // flakey-webdriverio-reporter/package.json
  + "types": "dist/reporter.d.ts",

  // flakey-cypress-reporter/package.json (CJS main — critical fix)
  + "types": "dist/reporter.d.ts",

  // flakey-cypress-snapshots/package.json
  + "types": "plugin.d.ts",
  ```
- **Risk if applied**: None for correctness. The `.d.ts` files already exist and are already resolved correctly by modern tooling. This only adds an explicit declaration for older resolvers.
- **Verification**: In a fresh project using `"moduleResolution": "node"`, `import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin"` should resolve types without errors. Also run `tsc --noEmit` in each consumer example project.

---

### M3. Bitbucket CI env vars missing from Playwright-reporter and WebdriverIO-reporter
- **File(s)**: `packages/flakey-playwright-reporter/src/reporter.ts:188-190`, `packages/flakey-webdriverio-reporter/src/reporter.ts:133-135`
- **Category**: inconsistency
- **Problem**: `flakey-cypress-reporter` reads `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`, and `BITBUCKET_BUILD_NUMBER` as fallbacks for branch, commitSha, and ciRunId respectively. Neither the Playwright reporter, the WebdriverIO reporter, nor their live-reporter adapters read these variables. Bitbucket Pipelines users of the Playwright or WebdriverIO stacks get empty branch/commit/ciRunId unless they manually pass the options — the same run metadata fields that Cypress users get automatically.
- **Evidence**:
  ```ts
  // flakey-cypress-reporter/src/plugin.ts:158-164 — Bitbucket vars present
  const branch = opts.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "";
  const commitSha = opts.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "";
  const resolveCiRunId = () =>
    opts.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "";

  // flakey-playwright-reporter/src/reporter.ts:188-190 — Bitbucket vars absent
  branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
  commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
  ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
  ```
- **Proposed change**: Apply the same three Bitbucket fallbacks to both packages (4 occurrences — the Playwright reporter `onEnd`, WebdriverIO reporter `onRunnerEnd`, and both live-reporter adapters `playwright.ts`/`webdriverio.ts` `onBegin`/`onRunnerStart`):
  ```diff
  // playwright-reporter/src/reporter.ts:188-190
  - branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_REF_NAME ?? "",
  + branch: this.options.branch ?? process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? "",
  - commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
  + commit_sha: this.options.commitSha ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? "",
  - ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
  + ci_run_id: this.options.ciRunId ?? process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_ID ?? process.env.BITBUCKET_BUILD_NUMBER ?? "",
  ```
  Apply the same diff to `webdriverio-reporter/src/reporter.ts:133-135`. (The `live-reporter` Playwright and WebdriverIO adapters already have `GITHUB_HEAD_REF` but also need the Bitbucket vars added at their respective `/live/start` body construction blocks — same pattern.)
- **Risk if applied**: None — purely additive env var fallbacks.
- **Verification**: Set only `BITBUCKET_BRANCH=feat/x BITBUCKET_COMMIT=abc BITBUCKET_BUILD_NUMBER=123` in the environment, run the reporters, confirm the uploaded run payload's `meta.branch/commit_sha/ci_run_id` fields are populated.

---

### M4. `flakey-core` exports map exposes `"./dist/*"` — published package leaks private internals
- **File(s)**: `packages/flakey-core/package.json:9`, `packages/flakey-cypress-reporter/package.json:9`, `packages/flakey-live-reporter/package.json:13`
- **Category**: misconfiguration
- **Problem**: Three packages include `"./dist/*": "./dist/*"` in their exports map. This makes every file in `dist/` (including type declarations and implementation details) addressable by external consumers as `@flakeytesting/core/dist/schema.js`, etc. Any import of an internal file bypasses the public surface contract and will break silently when internal paths change. It also defeats the purpose of the exports map as an encapsulation boundary.
- **Evidence**:
  ```json
  // flakey-core/package.json:7-10
  "exports": {
    ".": "./dist/index.js",
    "./dist/*": "./dist/*"     // exposes all internals
  }
  ```
- **Proposed change**: Remove the `"./dist/*"` wildcard entry from all three packages. If a specific internal is legitimately needed by consumers (currently: none found via grep), add it as an explicit named subpath export.
  ```diff
  // flakey-core/package.json
  "exports": {
    ".": "./dist/index.js"
  - "./dist/*": "./dist/*"
  }
  ```
  Apply the same removal to `flakey-cypress-reporter/package.json` and `flakey-live-reporter/package.json`.
- **Risk if applied**: Any consumer importing directly from `@flakeytesting/core/dist/schema.js` would break. Grep the repo: no callers found.
- **Verification**: `grep -rn '"@flakeytesting/core/dist/' packages/ examples/` returns zero hits after the change.

---

### M5. All artifact uploads use `readFileSync` into memory — large video files will exhaust heap in CI
- **File(s)**: `packages/flakey-core/src/api-client.ts:55-66`, `packages/flakey-cli/src/index.ts:215-230`
- **Category**: performance
- **Problem**: Every file upload path (`postRunWithFiles`, `uploadMultipart`, `flakey-cypress-reporter/plugin.ts` after-run handler) reads all artifact files fully into memory with `readFileSync` before passing them to `new Blob([data])` + `FormData`. For a typical Cypress run with 10 video files at 50–100 MB each, the Node.js process would need to hold ~500 MB–1 GB in heap simultaneously. The backend's `multer` limit is 200 MB per file; a 100 MB video already puts the process under significant GC pressure.
- **Evidence**:
  ```ts
  // flakey-core/src/api-client.ts:58-60
  for (const file of screenshots) {
    const data = readFileSync(file);   // entire file into Buffer
    formData.append("screenshots", new Blob([data], { type: "image/png" }), basename(file));
  }
  ```
- **Proposed change**: Node 18+ `fetch` + `FormData` + `Blob` does not natively stream from file paths, so the fix requires either (a) using `node-fetch` with `form-data` (which accepts `createReadStream`), or (b) chunking the upload (separate requests per large artifact), or (c) imposing a file-size gate and warning when files exceed a threshold. The least-invasive path for now:
  - Add a size gate: skip files > 100 MB with a `console.warn` and document the limit in the CLI help text.
  - Track the total across all files; warn if total > 500 MB before attempting.
  ```diff
  // flakey-core/src/api-client.ts — add before file loop
  + const MAX_FILE_BYTES = 100 * 1024 * 1024;
  + for (const file of [...screenshots, ...videos, ...snapshots]) {
  +   const size = statSync(file).size;
  +   if (size > MAX_FILE_BYTES) {
  +     console.warn(`[flakey] Skipping ${basename(file)} — ${Math.round(size/1024/1024)}MB exceeds 100MB limit`);
  +   }
  + }
  ```
  The proper long-term fix is streaming via `form-data` + `createReadStream`, which requires adding `form-data` as a dependency and replacing the native `fetch` multipart path.
- **Risk if applied**: The size gate changes behavior for existing users with large videos. Document the limit in the CLI `--help` output and `docs/uploading-results.md`.
- **Verification**: Run a multipart upload with a 110 MB file, confirm it is skipped with a warning rather than causing an out-of-memory crash.

---

## Priority: low

### L1. `flakey-live-reporter` dist contains a stale `mocha.js.bak` that will be published
- **File(s)**: `packages/flakey-live-reporter/dist/mocha.js.bak`
- **Category**: misconfiguration
- **Problem**: `dist/mocha.js.bak` is an untracked local file. The package's `"files": ["dist"]` includes the entire `dist/` directory, so if the package is published while this file exists on disk, it will appear in the npm tarball. It causes no runtime error but unnecessarily increases package size and is confusing.
- **Proposed change**: Delete the file and add a `.npmignore` or a glob exclusion:
  ```diff
  // Option A — simplest: delete the file
  rm packages/flakey-live-reporter/dist/mocha.js.bak

  // Option B — prevent future occurrences: add to root .gitignore
  + packages/*/dist/*.bak
  ```
- **Risk if applied**: None.
- **Verification**: `ls packages/flakey-live-reporter/dist/*.bak` returns nothing; `npm pack --dry-run` in that package does not list the file.

---

### L2. CLI has no `--help` flag — `flakey-upload --help` silently runs an upload with defaults
- **File(s)**: `packages/flakey-cli/src/index.ts:23-48`
- **Category**: bug
- **Problem**: `parseArgs()` treats every `--<key>` as a key-value pair consuming the next argument. Running `flakey-upload --help` parses `"help"` as a key with value `""` (no next arg), ignores it, and proceeds to call `upload()` with all defaults. The user sees "No report files found in cypress/reports for reporter 'mochawesome'" — not help text. The same applies to `flakey-upload coverage --help` which silently fails with a missing-arg error.
- **Evidence**:
  ```ts
  // index.ts:27-31 — no --help check
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1] ?? "";  // --help → opts["help"] = ""
      i++;
    }
  }
  ```
- **Proposed change**: Add a help check at the top of `parseArgs` (and mirrored in each subcommand), and add usage text for the top-level command:
  ```diff
  // Before the for-loop in parseArgs():
  + if (args.includes("--help") || args.includes("-h")) {
  +   console.log("Usage: flakey-upload [upload] [--suite <name>] [--report-dir <dir>] ...");
  +   console.log("       flakey-upload coverage --run-id <id> --file <file>");
  +   console.log("       flakey-upload a11y     --run-id <id> --file <file>");
  +   console.log("       flakey-upload visual   --run-id <id> --file <file>");
  +   console.log("       flakey-upload ui-coverage --suite <name> --file <file>");
  +   process.exit(0);
  + }
  ```
  Add the equivalent `if (args.includes("--help"))` guard at the top of each subcommand function.
- **Risk if applied**: None.
- **Verification**: `flakey-upload --help` prints usage and exits 0. `flakey-upload coverage --help` prints coverage-specific usage and exits 0.

---

### L3. `flakey-mcp-server` has no `"exports"` field — direct subpath imports of `dist/*` would bypass any future encapsulation
- **File(s)**: `packages/flakey-mcp-server/package.json`
- **Category**: misconfiguration
- **Problem**: `flakey-mcp-server` is a binary package (not a library), but it has no `"exports"` field. Since it is published to npm, a consumer could in theory do `import ... from "@flakeytesting/mcp-server/dist/index.js"`. For a bin-only package this is harmless today but adds an entry in `"exports"` that restricts accidental imports and signals the package's intent clearly.
- **Proposed change**:
  ```diff
  // flakey-mcp-server/package.json
  + "exports": {
  +   ".": "./dist/index.js"
  + },
  ```
- **Risk if applied**: None — the package has no library consumers.
- **Verification**: `node -e "import('@flakeytesting/mcp-server')"` resolves without error after adding the entry.

---

### L4. `flakey-webdriverio-reporter` has a mismatched peer/runtime dependency for WebdriverIO version
- **File(s)**: `packages/flakey-webdriverio-reporter/package.json:31-38`
- **Category**: misconfiguration
- **Problem**: The package declares `peerDependencies: { "@wdio/types": ">=8.0.0" }` — implying support for WebdriverIO 8 and 9. But it lists `"@wdio/reporter": "^9.27.0"` as a runtime `dependency`. `@wdio/reporter` v9 has its own peer dep on WebdriverIO v9 internals. A user on WebdriverIO 8 will install `@wdio/reporter@9` and get version mismatch errors at runtime. The peer dep range should match the runtime dep's major: either downgrade to `@wdio/reporter: "^8 || ^9"` or tighten the peer to `@wdio/types >=9.0.0`.
- **Evidence**:
  ```json
  "dependencies":    { "@wdio/reporter": "^9.27.0" },
  "peerDependencies": { "@wdio/types": ">=8.0.0"  }
  // @wdio/reporter@9 requires @wdio/types@9 transitively
  ```
- **Proposed change**:
  ```diff
  "peerDependencies": {
  -  "@wdio/types": ">=8.0.0"
  +  "@wdio/types": ">=9.0.0"
  }
  ```
  If WDIO 8 support is genuinely needed, change `"@wdio/reporter": "^8.0.0 || ^9.0.0"` and test both.
- **Risk if applied**: Users still on WDIO 8 will see a peer dependency warning at install time, which is the appropriate signal rather than a silent runtime failure.
- **Verification**: Install the package in a project with `@wdio/types@8`; the peer dep warning should appear. Install with `@wdio/types@9`; no warning.
