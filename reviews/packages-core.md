# Core / CLI / MCP / Snapshot packages audit

## Scope
- Files reviewed: 22 source/doc/config files across 5 packages
- Focus: docs vs reality, test coverage gaps, CLAUDE.md optimization
- Reviewer confidence: high — all src read in full, cross-referenced with docs

---

## flakey-core

### Medium

#### M1. `docs/reporter-package.md` uses `token`/`FLAKEY_TOKEN` but src uses `apiKey`/`FLAKEY_API_KEY`
- **File(s)**: `packages/flakey-core/docs/reporter-package.md:80,82,165,167,252,254,256,264`
- **Category**: inconsistency
- **Problem**: The Cypress and Playwright setup snippets pass `token: process.env.FLAKEY_TOKEN` and the `ApiClient` example shows `private token: string` / `constructor(options: { url: string; token: string })`. The real `src/api-client.ts` uses `private apiKey` / `constructor(options: ReporterOptions)` where `ReporterOptions.apiKey: string`. Anyone copying these snippets will wire the wrong field and get silent `undefined` auth.
- **Evidence**:
  ```ts
  // docs/reporter-package.md:80
  token: process.env.FLAKEY_TOKEN,

  // src/api-client.ts:7,11
  private apiKey: string;
  this.apiKey = options.apiKey;
  ```
- **Proposed change**: In `reporter-package.md`, replace every `token:` key with `apiKey:`, `FLAKEY_TOKEN` with `FLAKEY_API_KEY`, `private token` with `private apiKey`, and the constructor signature with `constructor(options: { url: string; apiKey: string })`. Affects lines 80, 82, 165, 167, 252, 254, 256, 264.
- **Risk if applied**: None — these are doc-only changes.
- **Verification**: `grep -n "token\|FLAKEY_TOKEN" packages/flakey-core/docs/reporter-package.md` returns zero hits after applying.

#### M2. `docs/reporter-package.md` documents a `project:` reporter option that does not exist
- **File(s)**: `packages/flakey-core/docs/reporter-package.md:82,167`
- **Category**: inconsistency
- **Problem**: Both the Cypress and Playwright setup snippets include `project: 'encor-tests'`. `ReporterOptions` in `src/schema.ts` has no `project` field; `flakey-cypress-reporter/src/reporter.ts` does not read it. The option is silently ignored.
- **Evidence**:
  ```ts
  // docs/reporter-package.md:82
  project: 'encor-tests',

  // src/schema.ts — ReporterOptions (full interface, no 'project' field)
  export interface ReporterOptions {
    url: string; apiKey: string; suite: string;
    branch?: string; commitSha?: string; ciRunId?: string; ...
  }
  ```
- **Proposed change**: Remove `project: 'encor-tests'` from both setup snippets (lines 82 and 167).
- **Risk if applied**: None — doc-only.
- **Verification**: `grep -n "project:" packages/flakey-core/docs/reporter-package.md` returns zero hits.

### Low

#### L1. CLAUDE.md consumers list omits `flakey-live-reporter`
- **File(s)**: `packages/flakey-core/CLAUDE.md:14-17`
- **Category**: inconsistency
- **Problem**: The consumers list names only `cypress-reporter`, `playwright-reporter`, `webdriverio-reporter`. `flakey-live-reporter` does not depend on `@flakeytesting/core` (confirmed via its `package.json`) so the list is complete as written — but the doc also doesn't mention that `flakey-cli` and the snapshot packages are intentionally independent. Add a note to prevent future confusion.
- **Proposed change**: Add one sentence: "The CLI and snapshot packages (`flakey-cli`, `flakey-cypress-snapshots`, `flakey-playwright-snapshots`, `flakey-live-reporter`) do not depend on this package."
- **Risk if applied**: None.
- **Verification**: Read the file.

---

## flakey-cli

### High

#### H1. `docs/uploading-results.md` uses `npx flakey-cli` for metrics subcommands — that binary does not exist
- **File(s)**: `packages/flakey-cli/docs/uploading-results.md:610,625,649,681`
- **Category**: bug (user-facing breakage)
- **Problem**: The published binary registered in `package.json` is `flakey-upload`. The metrics subcommand examples in the doc invoke `npx flakey-cli coverage`, `npx flakey-cli a11y`, etc. Running those commands will get "command not found". The main-upload examples earlier in the same doc (lines 125–495) correctly use `npx tsx /path/to/.../src/index.ts`, making this internally inconsistent as well.
- **Evidence**:
  ```json
  // package.json:6-8
  "bin": { "flakey-upload": "dist/index.js" }

  // docs/uploading-results.md:610
  npx flakey-cli coverage --run-id 42 --file coverage/coverage-summary.json
  ```
- **Proposed change**: Replace the four occurrences at lines 610, 625, 649, 681 with `npx flakey-upload`:
  ```diff
  - npx flakey-cli coverage --run-id 42 --file coverage/coverage-summary.json
  + npx flakey-upload coverage --run-id 42 --file coverage/coverage-summary.json
  ```
  Apply the same substitution to the `a11y`, `visual`, and `ui-coverage` calls.
- **Risk if applied**: None — doc-only.
- **Verification**: `grep -n "npx flakey-cli" packages/flakey-cli/docs/uploading-results.md` returns zero hits.

### Medium

#### M3. `docs/uploading-results.md` has two sections both labelled "Method 2"
- **File(s)**: `packages/flakey-cli/docs/uploading-results.md:197`
- **Category**: inconsistency
- **Problem**: The document has Method 1, Method 2 (CLI Uploader at line 117), another Method 2 (curl JSON-only at line 197), then Method 3. The duplicate heading means the curl sections are mis-numbered.
- **Proposed change**:
  ```diff
  - ## Method 2: curl (JSON only, no artifacts)
  + ## Method 3: curl (JSON only, no artifacts)
  ```
  And update the existing Method 3 at line 241:
  ```diff
  - ## Method 3: curl with multipart (with artifacts)
  + ## Method 4: curl with multipart (with artifacts)
  ```
- **Risk if applied**: None — doc-only.
- **Verification**: `grep -n "^## Method" packages/flakey-cli/docs/uploading-results.md` shows sequential numbering 1–4.

### Low

#### L2. No test harness for the CLI
- **File(s)**: `packages/flakey-cli/` (no test files exist)
- **Category**: dead-code / coverage
- **Problem**: `parseArgs`, `findReportFile`, `extractPlaywrightAttachments`, and `normalizeIstanbulSummary` are all pure functions testable without a running backend. There is no test file of any kind.
- **Proposed change**: Add `src/index.test.ts` covering: (a) `parseArgs` default fallback to env vars, (b) `findReportFile` returns null on empty dir, (c) `normalizeIstanbulSummary` handles both `{total: {...}}` and flat shapes, (d) `extractPlaywrightAttachments` deduplicates paths. Use Node's built-in test runner (`node:test`) — no framework dep needed.
- **Risk if applied**: None.
- **Verification**: `pnpm test` (once script is wired) passes.

---

## flakey-mcp-server

### Medium

#### M4. `src/index.ts` hardcodes `version: "0.1.0"` but `package.json` is `0.4.0`
- **File(s)**: `packages/flakey-mcp-server/src/index.ts:35`
- **Category**: inconsistency
- **Problem**: MCP clients that introspect the server version (e.g. to check compatibility) will see `0.1.0`. The package has been at `0.4.0` for multiple releases.
- **Evidence**:
  ```ts
  // src/index.ts:33-36
  const server = new McpServer({
    name: "flakey",
    version: "0.1.0",   // stale
  });
  ```
- **Proposed change**:
  ```diff
  - version: "0.1.0",
  + version: "0.4.0",
  ```
  Or import from `package.json` using `import pkg from "../package.json" assert { type: "json" }` and use `pkg.version` to avoid future drift.
- **Risk if applied**: None — cosmetic version string, not used in protocol routing.
- **Verification**: `node -e "import('./dist/index.js')"` — inspect server startup stderr (or just grep the dist).

### Low

#### L3. No tests for mutation-gate logic
- **File(s)**: `packages/flakey-mcp-server/` (no test files exist)
- **Category**: coverage
- **Problem**: The `FLAKEY_MCP_ALLOW_MUTATIONS` gate is the primary safety mechanism for `analyze_error`. It has no automated test. A spawn-process test can verify: (a) with `FLAKEY_MCP_ALLOW_MUTATIONS` unset, the tool is absent from the server's tool list, (b) with it set to `1`, the tool is present and its description starts with `[mutates server state]`.
- **Proposed change**: Add `src/index.test.ts` with two `node:test` cases that spawn `tsx src/index.ts` with a mock MCP client over stdio, send `tools/list`, and assert presence/absence of `analyze_error`.
- **Risk if applied**: None.
- **Verification**: Test passes without `FLAKEY_MCP_ALLOW_MUTATIONS` set, and with it set to `1`.

---

## flakey-cypress-snapshots

### Medium

#### M5. `docs/plugin.md` `SnapshotBundle` schema block missing `cappedSteps`/`evictedSteps` fields added in v0.6.2
- **File(s)**: `packages/flakey-cypress-snapshots/docs/plugin.md:48-55`
- **Category**: inconsistency
- **Problem**: The "Data format" section shows a `SnapshotBundle` interface without the two fields shipped in v0.6.2. The fields are present in `src/plugin.ts` (`cappedSteps?: number`, `evictedSteps?: number`) and on every bundle emitted by `support.ts`. A consumer reading the schema to build a bundle parser won't know to handle them.
- **Evidence**:
  ```ts
  // docs/plugin.md:48-55 — SnapshotBundle schema shown:
  interface SnapshotBundle {
    version: 1;
    testTitle: string;
    specFile: string;
    viewportWidth: number;
    viewportHeight: number;
    steps: SnapshotStep[];
    // cappedSteps and evictedSteps absent
  }

  // src/plugin.ts:35-38
  cappedSteps?: number;
  evictedSteps?: number;
  ```
- **Proposed change**: Add the two optional fields to the schema block in the doc:
  ```diff
    steps: SnapshotStep[];
  + cappedSteps?: number;   // Steps replaced with placeholder (per-step cap). Added v0.6.2.
  + evictedSteps?: number;  // Steps dropped FIFO (aggregate cap). Added v0.6.2.
  }
  ```
- **Risk if applied**: None — doc-only.
- **Verification**: Schema in doc matches `src/plugin.ts` `SnapshotBundle` interface field-for-field.

### Low

#### L4. No unit tests for eviction logic
- **File(s)**: `packages/flakey-cypress-snapshots/` (no test files exist)
- **Category**: coverage
- **Problem**: `cappedCount`, `evictedCount`, `enforceBundleSize`, and `appendStep` in `shared.ts` are pure logic with no browser dependency. The `capHtml`, `resetState`, and `appendStep` functions can be exercised directly. This is the only safety net for the cap logic introduced in v0.6.1 and v0.6.2.
- **Proposed change**: Add `src/shared.test.ts` using `node:test`. Minimum cases: (a) `capHtml` returns placeholder when `html.length > max`, (b) `appendStep` evicts when `> MAX_STEPS`, (c) `enforceBundleSize` evicts FIFO and increments `evictedCount`, (d) `resetState` zeroes all counters. `shared.ts` has no Cypress globals in its exports — mock `Cypress.env` calls inside `getMaxHtmlBytes`/`getMaxBundleBytes` by injecting a global before the import.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes.

---

## flakey-playwright-snapshots

### High

#### H2. `parseTrace` always returns `snapshotBundle: null` — screencast frame resource lookup uses bare sha1 hash but map keys include file extensions
- **File(s)**: `packages/flakey-playwright-snapshots/src/index.ts:124-128,206-209`
- **Category**: bug
- **Problem**: Screencast frames in a Playwright trace reference resources by their sha1 hash (e.g. `"abc123def"` — no extension). The code stores resources in the map under two keys: `fileName` (`"abc123def.jpeg"`) and the full path (`"resources/abc123def.jpeg"`). At lookup time (line 206), `resources.has(closestFrame.sha1)` checks for `"abc123def"` — which matches neither stored key. Result: `closestFrame` is found but `resources.has(...)` is always `false`, no steps are ever pushed, and `snapshotBundle` is always `null`. Playwright snapshot capture produces zero output silently.

  Secondary issue on line 209: even if the lookup were fixed, `closestFrame.sha1.endsWith(".png")` is always `false` (sha1 is a hash with no extension), so `mimeType` would always be `"image/jpeg"` regardless of actual format.
- **Evidence**:
  ```ts
  // Line 127-128: keys stored WITH extension
  const fileName = name.slice("resources/".length);  // e.g. "abc123def.jpeg"
  resources.set(fileName, entry.getData());
  resources.set(name, entry.getData());              // "resources/abc123def.jpeg"

  // Line 206: lookup with bare hash — never matches
  if (closestFrame && resources.has(closestFrame.sha1)) {
    const imageData = resources.get(closestFrame.sha1)!;
    const mimeType = closestFrame.sha1.endsWith(".png") ? "image/png" : "image/jpeg"; // always jpeg
  ```
- **Proposed change**:
  ```diff
  // Replace lines 206-209:
  - if (closestFrame && resources.has(closestFrame.sha1)) {
  -   const imageData = resources.get(closestFrame.sha1)!;
  -   const mimeType = closestFrame.sha1.endsWith(".png") ? "image/png" : "image/jpeg";
  + const sha1 = closestFrame.sha1;
  + const resourceKey = resources.has(sha1 + ".jpeg") ? sha1 + ".jpeg"
  +   : resources.has(sha1 + ".png") ? sha1 + ".png"
  +   : resources.has(sha1) ? sha1
  +   : null;
  + if (closestFrame && resourceKey) {
  +   const imageData = resources.get(resourceKey)!;
  +   const mimeType = resourceKey.endsWith(".png") ? "image/png" : "image/jpeg";
  ```
- **Risk if applied**: The fix changes which key is used for lookup. If any real Playwright trace uses a sha1 key without an extension in the zip, the fallback `resources.has(sha1)` handles it. Rebuild and run against an actual trace zip to confirm steps are populated.
- **Verification**: Call `parseTrace` with a real Playwright trace zip file; assert `result.snapshotBundle !== null` and `result.snapshotBundle.steps.length > 0`.

### Low

#### L5. No tests for `parseTrace` / `parseAndSaveTrace`
- **File(s)**: `packages/flakey-playwright-snapshots/` (no test files exist)
- **Category**: coverage
- **Problem**: Both exported functions have zero test coverage. Given the H2 bug above went undetected, a fixture-based test with a minimal synthetic trace zip would catch regressions.
- **Proposed change**: Add `src/index.test.ts` using `node:test`. Build a minimal trace zip in-memory using `adm-zip` (already a dep): one `0-trace.trace` with a `context-options` line and two action pairs (before/after), one `screencastFrame` entry, and one `resources/<sha1>.jpeg` entry. Assert `commandLog` has two entries and `snapshotBundle.steps` has one entry with a valid data URI in `html`.
- **Risk if applied**: None.
- **Verification**: `pnpm test` passes.
