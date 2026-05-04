---
description: Verify env-var consistency, peer-dep declarations, and exports map across the @flakeytesting/* reporter packages
---

Audit the `packages/*` workspace for the cross-package conventions that make the reporter family work as a coherent suite.

## Goal

The reporter packages (cypress-reporter, cypress-snapshots, live-reporter, playwright-reporter, playwright-snapshots, webdriverio-reporter, core, cli, mcp-server) share env-var names, share the live-event protocol, and depend on each other as optional peers. A small drift — a renamed env var on one side, a missing `dist/` entry in `exports`, a `cypress` peer declared on one package but not its sibling — silently breaks integration in real consumer projects without breaking the build of any individual package.

## What to check

1. **Env-var resolution chains.** Walk every reporter for `process.env.<NAME>` references. The canonical names that should appear identically across reporters that need them:
   - `FLAKEY_API_URL` — backend base URL
   - `FLAKEY_API_KEY` — auth token
   - `FLAKEY_SUITE` — suite-name fallback
   - `FLAKEY_LIVE_RUN_ID` — pre-set run id; skips `/live/start`
   - `FLAKEY_ENV` / `TEST_ENV` — target environment label (mocha live-reporter + cypress reporter)
   - `FLAKEY_RELEASE` — release version (cypress reporter)
   - CI run id chain: `CI_RUN_ID` / `GITHUB_RUN_ID` / `BITBUCKET_BUILD_NUMBER`
   - Branch chain: `BRANCH` / `GITHUB_HEAD_REF` / `GITHUB_REF_NAME` / `BITBUCKET_BRANCH`
   - Commit chain: `COMMIT_SHA` / `GITHUB_SHA` / `BITBUCKET_COMMIT`

   Flag any reporter that resolves a different chain (e.g. one reads only `GITHUB_RUN_ID`, another reads `CI_RUN_ID` first) where a CI provider should be supported uniformly.

2. **`package.json` `exports` map.** For each package, every entry in `exports` must point at a real file in `dist/` after `pnpm build`. Common drift:
   - `"./dist/*"` wildcard included accidentally — leaks build internals (audit fix `84aed35` already removed these).
   - Subpath listed in `exports` but not built (e.g. `./cucumber` declared but no `dist/cucumber.js` produced).
   - Conditional exports (`"types": "./dist/x.d.ts"`) missing — consumers on default Node module resolution don't get types (audit fix `4372c46` added these).

   For each package, list the `exports` keys and confirm every one resolves to a real file after a build. Use `pnpm build` output to reason about what's emitted (don't run it; read `tsconfig.json` `outDir` and the `package.json` `files` array).

3. **CommonJS-vs-ESM.** Two specific entries are CJS by necessity:
   - `flakey-cypress-reporter` Mocha entry (`dist/reporter.cjs`) — Cypress's Mocha reporter loader uses `require`, not `import`. The package has `scripts/build-cjs.cjs` for this. Confirm the entry referenced in `exports["."]` is `.cjs`.

   Everything else should be ESM (`type: "module"` in `package.json`). Flag if a package declares `type: "module"` but ships a CJS entry without the `.cjs` extension, or vice-versa.

4. **Peer dependencies.** Each reporter that wraps a test framework declares it as an **optional** peer (so the reporter can be installed alongside the framework without forcing a particular version). Cross-check:
   - `cypress-reporter` peer: `cypress >=12.0.0` (required), `cypress-snapshots` + `live-reporter` (optional)
   - `cypress-snapshots` peer: `cypress >=12.0.0`, `@badeball/cypress-cucumber-preprocessor` (optional, only for the `./cucumber` subpath)
   - `playwright-reporter` peer: `@playwright/test >=1.30.0` (optional — the reporter is only useful alongside Playwright but we don't force install)
   - `webdriverio-reporter` peer: `webdriverio` / `@wdio/cli` at the appropriate version
   - `live-reporter` — no required peers; framework adapters live behind subpath imports

   Per-package `CLAUDE.md` should agree with the actual `peerDependencies` section. Drift = silent installation failure for consumers.

5. **`@flakeytesting/core` re-use.** The `flakey-core` package owns shared helpers (upload helpers, normalized schemas). Each reporter that uploads a run should depend on it (workspace ref) instead of duplicating the upload code. Grep for inline `fetch("${url}/runs", ...)` in reporters that should be calling `core` instead — drift means a backend payload-shape change has to be applied N times instead of once.

6. **CommonJS / ESM build outputs.** `flakey-cypress-snapshots` ships `plugin.js`, `support.js`, `cucumber.js`, `plugin.d.ts`, etc. — thin re-export entries for each subpath. Confirm:
   - Every advertised subpath in `exports` has a JS entry
   - Every advertised subpath has a `.d.ts` (so consumers on default Node module resolution get types — see audit fix `4372c46`)

7. **Workspace version pinning.** When one workspace package depends on another, the dep should be `"workspace:*"` (pnpm) so local development picks up the local source. Grep `packages/*/package.json` for sibling deps and confirm none use a published version (`"^0.5.0"`) — that would mean local changes to one package don't reach another.

## Report

- **High** — `exports` entry references a file that won't exist after build; CJS entry missing a `.cjs` extension; required peer declared as a regular dep (forces consumer's framework version).
- **Medium** — env-var chain differs across reporters where it shouldn't; missing types entry for an advertised subpath; sibling workspace dep using a published version instead of `workspace:*`.
- **Low** — `CLAUDE.md` for one reporter mentions an env var the code no longer reads; deps `peerDependencies` listed but not in `peerDependenciesMeta` as `optional: true`.

For each: package + file + the diff to apply.

## Useful starting points

- `packages/*/package.json`
- `packages/*/CLAUDE.md`
- `packages/flakey-cypress-reporter/scripts/build-cjs.cjs`
- `packages/flakey-live-reporter/src/{mocha,playwright,webdriverio}.ts` — env-var resolution chains
- `packages/flakey-cypress-reporter/src/plugin.ts` — env-var resolution chain (lazy)
- `packages/flakey-core/src/` — shared helpers
- `pnpm-workspace.yaml` — workspace boundary

## Delegate to

Use the `flakey-auditor` agent: `"Audit env-var consistency, exports map, peer-dep declarations, and CJS/ESM discipline across the @flakeytesting/* reporter packages."` Read-only.
