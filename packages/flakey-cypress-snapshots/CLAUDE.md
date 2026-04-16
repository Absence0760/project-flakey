# @flakeytesting/cypress-snapshots

Cypress plugin that captures DOM snapshots at each command step and bundles them for upload alongside the run.

## Commands

- `pnpm build` — `tsc` → `dist/`
- `pnpm dev` — `tsc --watch`

## Plugin options

`flakeySnapshots(on, config, options?)` accepts exactly two options (see `src/plugin.ts`):

| Option | Type | Default | Notes |
|---|---|---|---|
| `outputDir` | `string` | `"cypress/snapshots"` | Where snapshot bundles are written. |
| `enabled` | `boolean` | `true` | Set `false` to disable capture entirely (added in 0.5.0). Exposed to the support file via `Cypress.env("FLAKEY_SNAPSHOTS_ENABLED")`. |

The user-facing doc lives at `docs/plugin.md` (next to this file).

## Layout

- `src/plugin.ts` — Cypress plugin (runs in Node; wires `after:spec` etc.)
- `src/support.ts` — Cypress support file (runs in the browser; captures DOM)
- `plugin.js` / `support.js` — thin JS entries that re-export from `dist/`
- Build output goes to `dist/`; published files are declared in `package.json` `files`.

## Consumer wiring

```ts
// cypress.config.ts
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      flakeySnapshots(on, config);
      return config;
    },
  },
});

// cypress/support/e2e.ts
import "@flakeytesting/cypress-snapshots/support";
```

## Peer deps

`cypress >=12.0.0`. Don't add Cypress as a direct dep.
