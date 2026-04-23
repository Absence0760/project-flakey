# @flakeytesting/core

Shared utilities used by the reporter packages (`cypress-reporter`, `playwright-reporter`, `webdriverio-reporter`). No consumer-facing API surface of its own.

## Commands

- `pnpm build` — `tsc` → `dist/`

No dev/watch script; depend on the reporters' own dev flows when iterating.

## Consumers

Referenced via `workspace:*` from:

- `@flakeytesting/cypress-reporter`
- `@flakeytesting/playwright-reporter`
- `@flakeytesting/webdriverio-reporter`

The CLI and snapshot packages (`flakey-cli`, `flakey-cypress-snapshots`, `flakey-playwright-snapshots`, `flakey-live-reporter`) do not depend on this package.

Changes here require rebuilding the consumers (or relying on TypeScript project references) before behavior propagates.

## Conventions

- Keep this package runtime-agnostic — don't import Cypress/Playwright/WDIO types here. Anything framework-specific belongs in the respective reporter package.
- Breaking API changes cascade to every reporter, so bump the core version and the reporters together.
