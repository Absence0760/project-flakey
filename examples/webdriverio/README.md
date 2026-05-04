# Better Testing — WebdriverIO example

WebdriverIO 8/9 integration example for the Better Testing platform (`@flakeytesting/webdriverio-reporter`).

Runs against the shared todo app at `http://localhost:4444` (see `examples/shared/app`).

## Prerequisites

- Node.js 18+, pnpm
- Chrome / Chromium in PATH
- Shared app running: `cd examples/shared/app && pnpm dev`
- Copy `.env.example` to `.env` and fill in `FLAKEY_API_KEY`

## Scripts

| Script | Description |
|---|---|
| `pnpm test:smoke` | Smoke suite — happy-path tests |
| `pnpm test:sanity` | Sanity suite — broader functional coverage |
| `pnpm test:regression` | Regression suite — edge cases and known failures |
| `pnpm test:a11y` | Accessibility scan (axe-core, WCAG 2.0 A/AA) |
| `pnpm test:visual` | Visual regression compare against baselines |
| `pnpm test:visual:update` | Regenerate visual baselines |
| `pnpm test:flaky` | Intentionally flaky tests (for flaky-detection demo) |
| `pnpm coverage:upload` | Upload `coverage/coverage-summary.json` to Better Testing |

## Features exercised

### Accessibility (`tests/a11y/`)
Uses axe-core injected via `browser.execute()` to scan each page for WCAG 2.0 A/AA
violations. Violations are logged with impact level and node HTML but do **not** cause
hard failures by default. Set `FAIL_ON_A11Y_VIOLATIONS=true` to enforce zero violations.

Results are written to `reports/a11y/*.json` and can be uploaded with:
```
npx tsx ../../packages/flakey-cli/src/index.ts a11y --run-id <id> --file reports/a11y/todos-a11y.json
```

### Visual regression (`tests/visual/`)
Captures screenshots with `browser.saveScreenshot()` and compares against PNG baselines
in `tests/visual/baselines/` using `pixelmatch`. Fails when pixel difference exceeds 1%
(configurable via `VISUAL_DIFF_THRESHOLD` env var). Run `test:visual:update` to
regenerate baselines after intentional UI changes.

Diff manifest is written to `reports/visual/manifest.json` and can be uploaded with:
```
npx tsx ../../packages/flakey-cli/src/index.ts visual --run-id <id> --file reports/visual/manifest.json
```

### Flaky detection (`tests/flaky/`)
Three tests that fail randomly ~30% of the time. Run repeatedly to generate the
flakiness signal that Better Testing uses for detection and tracking. These specs are
isolated in `tests/flaky/` and are **not** included in `smoke`, `sanity`, or `regression`
spec globs.

### Coverage upload (`coverage/`)
A static Istanbul `coverage-summary.json` demonstrates the coverage-upload flow.
In real usage, replace this file with the output of your instrumented test run (e.g.
`nyc report --reporter=json-summary`).

### Release metadata
The reporter accepts a `release` option (or reads `FLAKEY_RELEASE` from the
environment) and forwards it on the run upload.  The backend upserts the release
on first sight and links every run with the same tag to it.  Wire it in
`wdio.conf.ts` either implicitly via the env var:

```bash
FLAKEY_RELEASE=v1.2.3 pnpm test:smoke
```

or explicitly via reporter options:

```ts
reporters: [
  [FlakeyReporter, {
    url, apiKey, suite,
    release: process.env.FLAKEY_RELEASE ?? "",
  }],
];
```

## Running all feature suites

```bash
pnpm test:smoke
pnpm test:a11y
pnpm test:visual
# Flaky suite — run multiple times to build up signal:
for i in {1..5}; do pnpm test:flaky; done
pnpm coverage:upload
```
