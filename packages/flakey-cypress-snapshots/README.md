# @flakeytesting/cypress-snapshots

Cypress plugin that captures DOM snapshots at each command step so you can replay a failing test in the [Flakey](https://github.com/Absence0760/project-flakey) dashboard without re-running it. Each snapshot bundle records the serialised DOM, viewport size, scroll position, and per-step metadata — rendered as a step-by-step scrubber in the dashboard.

## Install

```bash
pnpm add -D @flakeytesting/cypress-snapshots
# or
npm install --save-dev @flakeytesting/cypress-snapshots
```

`cypress` is a required peer (`>=12.0.0`). `@badeball/cypress-cucumber-preprocessor` is optional — only needed for the `./cucumber` subpath.

## Quick start

Two changes:

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      flakeySnapshots(on, config);
      return config;
    },
  },
});
```

```ts
// cypress/support/e2e.ts
import "@flakeytesting/cypress-snapshots/support";
```

If you also use `@flakeytesting/cypress-reporter`, calling `setupFlakey(on, config)` wires snapshots automatically — you don't need to call `flakeySnapshots` separately.

## Cucumber projects

If you use `@badeball/cypress-cucumber-preprocessor`, additionally import the cucumber subpath from a **step-definition file** (NOT from `support/e2e.ts`):

```ts
// cypress/e2e/_flakey-cucumber-hooks.ts
import "@flakeytesting/cypress-snapshots/cucumber";
```

This registers a `BeforeStep` hook that pushes Gherkin step markers into the snapshot bundle. Importing it from the support file breaks because the preprocessor's per-feature registry isn't available in the support context.

## Options

`flakeySnapshots(on, config, options?)` accepts:

| Option | Type | Default | Notes |
|---|---|---|---|
| `outputDir` | `string` | `"cypress/snapshots"` | Where snapshot bundles are written |
| `enabled` | `boolean` | `true` | Set `false` to disable capture entirely |
| `maxHtmlBytes` | `number` | `2 * 1024 * 1024` (2 MB) | Per-step HTML size cap — oversized DOMs (PDF iframes, etc.) are replaced with a placeholder + `console.warn` |
| `maxBundleBytes` | `number` | `64 * 1024 * 1024` (64 MB) | Aggregate cap across all steps in one test — oldest steps evicted FIFO when exceeded |

Each option is also exposed to the browser via `Cypress.env("FLAKEY_SNAPSHOTS_*")` so the support file picks them up automatically.

## Live streaming

When `FLAKEY_API_URL`, `FLAKEY_API_KEY`, and `FLAKEY_LIVE_RUN_ID` are all set in the process environment, snapshot bundles stream to `POST /live/:runId/snapshot` immediately after they're written to disk. On a successful upload the local file is `unlinkSync`ed. On failure (or when no live run is active) the file stays on disk and gets picked up by the end-of-run batch uploader instead.

`@flakeytesting/cypress-reporter`'s `setupFlakey` populates the env vars automatically via `@flakeytesting/live-reporter`.

## Compatibility

- Cypress: `>=12.0.0` (required peer)
- `@badeball/cypress-cucumber-preprocessor`: `>=20.0.0` (optional peer)
- Node: 20+

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
