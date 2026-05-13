# @flakeytesting/core

Internal shared utilities used by the [Flakey](https://github.com/Absence0760/project-flakey) reporter packages:

- [`@flakeytesting/cypress-reporter`](https://www.npmjs.com/package/@flakeytesting/cypress-reporter)
- [`@flakeytesting/playwright-reporter`](https://www.npmjs.com/package/@flakeytesting/playwright-reporter)
- [`@flakeytesting/webdriverio-reporter`](https://www.npmjs.com/package/@flakeytesting/webdriverio-reporter)
- [`@flakeytesting/cli`](https://www.npmjs.com/package/@flakeytesting/cli)

You don't install this package directly. The reporters pull it in automatically as a workspace dependency. It's published only so the reporters can resolve a hosted version when consumers install them outside the monorepo.

## What's inside

- **`ApiClient`** — wraps `fetch` for the two upload paths (`POST /runs` JSON-only, `POST /runs/upload` multipart with screenshots/videos/snapshots) plus the per-metric endpoints (coverage, a11y, visual, ui-coverage)
- **`NormalizedRun`, `NormalizedSpec`, `NormalizedTest`** — the schema every reporter normalises into, so the backend sees the same payload shape regardless of test runner
- **`ReporterOptions`** — the shared options type all framework reporters extend

Anything framework-specific (Cypress's Mocha events, Playwright's Reporter interface, WebdriverIO's `@wdio/reporter` base class) lives in the framework-specific package, not here.

## Versioning

Breaking changes here cascade to every reporter. The reporters and core are bumped together at each release tag — there's no scenario where you'd install a core minor by itself.

## Compatibility

- Node 20+
- Runtime-agnostic — no `cypress` / `@playwright/test` / `webdriverio` imports here

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
