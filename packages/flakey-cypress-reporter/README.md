# @flakeytesting/cypress-reporter

Cypress reporter + plugin + support bundle for the [Flakey](https://github.com/Absence0760/project-flakey) test reporting dashboard. Uploads results, screenshots, videos, and (with `@flakeytesting/cypress-snapshots`) DOM snapshots, and streams per-test events live as the suite runs.

## Install

```bash
pnpm add -D @flakeytesting/cypress-reporter @flakeytesting/cypress-snapshots @flakeytesting/live-reporter
# or
npm install --save-dev @flakeytesting/cypress-reporter @flakeytesting/cypress-snapshots @flakeytesting/live-reporter
```

`cypress` is a required peer (`>=12.0.0`). The snapshots + live-reporter packages are optional peers — install them only if you want DOM snapshots and live streaming.

## Quick start

Two changes to your Cypress config:

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { setupFlakey } from "@flakeytesting/cypress-reporter/plugin";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url:    process.env.FLAKEY_API_URL,
    apiKey: process.env.FLAKEY_API_KEY,
    suite:  "my-app-e2e",
  },
  e2e: {
    setupNodeEvents(on, config) {
      return setupFlakey(on, config);
    },
  },
});
```

Add one line to your support file (for DOM snapshots — optional):

```ts
// cypress/support/e2e.ts
import "@flakeytesting/cypress-snapshots/support";
```

Then run as usual:

```bash
FLAKEY_API_URL=https://flakey.your-domain.com \
FLAKEY_API_KEY=fk_xxx... \
cypress run
```

## What `setupFlakey` wires up

`setupFlakey(on, config, opts?)` composes three things behind one call:

- **Result uploads** — POSTs the run + screenshots + videos to `/runs/upload` at end-of-run.
- **DOM snapshots** (when `@flakeytesting/cypress-snapshots` is installed) — captures the DOM at each command step. Snapshots stream live to the backend if a live run is active; otherwise they batch with the end-of-run upload.
- **Live streaming** (when `@flakeytesting/live-reporter` is installed) — opens a live run via `POST /live/start`, fires per-test `test.started` / `test.passed` / `test.failed` events as the suite runs, sends a 30s heartbeat so quiet suites don't auto-abort, and POSTs `run.aborted` on SIGINT/SIGTERM.

Opt out of either layer via `setupFlakey(on, config, { snapshots: false, live: false })`.

## Reporter options

| Option | Type | Fallback | Notes |
|--------|------|----------|-------|
| `url` | string | `FLAKEY_API_URL` env | Backend base URL. Required. |
| `apiKey` | string | `FLAKEY_API_KEY` env | API key. Required. |
| `suite` | string | `FLAKEY_SUITE` env, then `"default"` | Suite name shown in the dashboard. |
| `branch` | string | env chain | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` |
| `commitSha` | string | env chain | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` |
| `ciRunId` | string | env chain | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` |
| `release` | string | `FLAKEY_RELEASE` env | Release version — backend upserts release + links run |
| `environment` | string | `FLAKEY_ENV` → `TEST_ENV` env, then `config.env.environment` / `config.env.name` | Target env label (e.g. `qa`, `stage`) |
| `verbose` | boolean | `FLAKEY_VERBOSE=1` env | Logs upload success / live-run progress |

## Per-test screenshot streaming

Each PNG written by Cypress is POSTed to `/live/:runId/screenshot` the moment `after:screenshot` fires, with the spec path and full test title attached so the backend can link it directly to the test row. On a successful upload the local file is `unlinkSync`ed — the end-of-run batch's directory walk naturally skips it. This prevents a long failure-heavy suite from filling the CI runner's disk before `after:run` ever fires.

## Compatibility

- Cypress: `>=12.0.0` (required peer)
- Node: 20+
- Cypress 15+: the reporter and plugin live in different processes; this package's process-ancestry walk handles that automatically (no `pid`-based file matching).

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- [Changelog (GitHub releases)](https://github.com/Absence0760/project-flakey/releases)
- License: MIT
