# @flakeytesting/live-reporter

Lightweight framework-agnostic adapters that stream live test events (start/pass/fail) to the Flakey backend in real time.

## Commands

- `pnpm build` — `tsc` → `dist/`

## Entry points

One subpath per supported framework:

- `.` → generic event emitter / transport
- `./playwright` — Playwright reporter adapter
- `./mocha` — Mocha reporter adapter (used inside Cypress)
- `./webdriverio` — WebdriverIO reporter adapter

When adding a framework, follow the existing shape: emit normalized events through the shared transport in `dist/index.js`, don't re-implement the transport per adapter.

## Consumer wiring

Loaded as an optional peer by `@flakeytesting/cypress-reporter`. Standalone users import the subpath matching their framework directly.
