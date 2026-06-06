# @flakeytesting/live-reporter

Framework-agnostic adapters that stream live test events (start, pass, fail, abort) from your test runner to the [Flakey](https://github.com/Absence0760/project-flakey) backend in real time. Pairs with the framework-specific reporters in `@flakeytesting/{cypress,playwright,webdriverio}-reporter`.

The result: open the dashboard while a long suite is still running and watch tests turn green or red the moment each one finishes.

## Install

```bash
pnpm add -D @flakeytesting/live-reporter
# or
npm install --save-dev @flakeytesting/live-reporter
```

No required peers — each framework adapter is a subpath import and only loads what you reach for.

## Quick start

### Cypress (via setupFlakey — recommended)

If you use `@flakeytesting/cypress-reporter`, `setupFlakey(on, config)` wires this in automatically. Nothing else to do.

### Cypress (standalone)

```ts
// cypress.config.ts
import { register } from "@flakeytesting/live-reporter/mocha";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      register(on, {
        url:    process.env.FLAKEY_API_URL,
        apiKey: process.env.FLAKEY_API_KEY,
        suite:  "my-app-e2e",
      }, config); // pass `config` as 3rd arg for Cypress --env compatibility
      return config;
    },
  },
});
```

### Playwright

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["@flakeytesting/playwright-reporter", { /* ... */ }],
    ["@flakeytesting/live-reporter/playwright", {
      url:    process.env.FLAKEY_API_URL,
      apiKey: process.env.FLAKEY_API_KEY,
      suite:  "my-app-e2e",
    }],
  ],
});
```

### WebdriverIO

```ts
// wdio.conf.ts
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";
import FlakeyLiveReporter from "@flakeytesting/live-reporter/webdriverio";

export const config = {
  reporters: [
    [FlakeyReporter, { /* ... */ }],
    [FlakeyLiveReporter, {
      url:    process.env.FLAKEY_API_URL,
      apiKey: process.env.FLAKEY_API_KEY,
      suite:  "my-app-e2e",
    }],
  ],
};
```

## Env vars

All adapters read these from `process.env` as fallbacks when the matching `config.*` field is absent:

| Variable | Notes |
|---|---|
| `FLAKEY_API_URL` | Base URL; overridden by `config.url` |
| `FLAKEY_API_KEY` | Auth token; overridden by `config.apiKey` |
| `FLAKEY_SUITE` | Suite name fallback; overridden by `config.suite` |
| `FLAKEY_LIVE_RUN_ID` | Pre-set run id; skips `/live/start` call when set |
| `BRANCH` / `GITHUB_HEAD_REF` / `GITHUB_REF_NAME` / `BITBUCKET_BRANCH` | Branch fallback chain |
| `COMMIT_SHA` / `GITHUB_SHA` / `BITBUCKET_COMMIT` | Commit SHA fallback chain |
| `CI_RUN_ID` / `GITHUB_RUN_ID` / `BITBUCKET_BUILD_NUMBER` | CI run id fallback |
| `FLAKEY_ENV` / `TEST_ENV` | Target env label (e.g. `qa`, `stage`) |

## Heartbeat

Once started, the live client ticks an `unref`'d 30-second interval that POSTs an empty events array. The backend's `/live/:runId/events` handler updates `lastEventAt` via `LiveEventBus.touch()` on every POST, even empty ones. This stops the stale-run detector (default 10-minute timeout) from auto-aborting a still-running suite during long quiet stretches — slow Cucumber scenarios, large `cy.wait`s, debugger pauses, etc.

Disable with `heartbeatIntervalMs: 0` if you have a different keep-alive strategy.

## Live run lifecycle

1. **`before:run`** — POST `/live/start` (suite + CI metadata). Backend creates a placeholder `runs` row and returns the numeric `run_id`.
2. **Per test** — POST `/live/:runId/events` with `{ type: 'test.started' | 'test.passed' | 'test.failed' | 'test.skipped', spec, test, ... }`. Events queue and flush on a 500ms window (LiveClient batches via setTimeout); the Cypress reporter posts each per-test event immediately.
3. **30s tick** — POST `/live/:runId/events` with `[]` (heartbeat).
4. **`after:run`** — `client.stop()` cancels the heartbeat; final `client.flush()` empties the queue. The framework-specific reporter then uploads the full run via `/runs/upload`, and the backend merges into the same placeholder by `ci_run_id`.
5. **SIGINT/SIGTERM** — POST `/live/:runId/abort` so the dashboard immediately reflects "run aborted" and pending test rows transition to `skipped`.

## Compatibility

- Node 20+
- Cypress / Playwright / WebdriverIO: any version supported by the corresponding framework reporter

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
