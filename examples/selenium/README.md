# Better Testing — Selenium example

Selenium WebDriver 4 + Mocha + Mochawesome integration example for the Better Testing
platform. Results are uploaded via the `@flakeytesting/cli` (`flakey-upload` binary).

Runs against the shared todo app at `http://localhost:4444` (see `examples/shared/app`).

## Prerequisites

- Node.js 18+, pnpm
- Chrome / Chromium in PATH
- Shared app running: `cd examples/shared/app && pnpm dev`
- Copy `.env.example` to `.env` and fill in `FLAKEY_API_KEY`

## Scripts

| Script | Description |
|---|---|
| `pnpm test:smoke` | Smoke suite + upload to Better Testing |
| `pnpm test:sanity` | Sanity suite + upload |
| `pnpm test:regression` | Regression suite + upload |
| `pnpm test:a11y` | Accessibility scan (axe-core, WCAG 2.0 A/AA) |
| `pnpm test:visual` | Visual regression compare against baselines |
| `pnpm test:visual:update` | Regenerate visual baselines |
| `pnpm test:flaky` | Intentionally flaky tests (for flaky-detection demo) |
| `pnpm coverage:upload` | Upload `coverage/coverage-summary.json` to Better Testing |

## Features exercised

### Accessibility (`tests/a11y/`)
Uses axe-core injected via `driver.executeScript()` to scan each page for WCAG 2.0 A/AA
violations. Violations are logged with impact level and node HTML but do not cause
hard failures by default. Set `FAIL_ON_A11Y_VIOLATIONS=true` to enforce zero violations.
Results written to `reports/a11y/*.json`.

### Visual regression (`tests/visual/`)
Captures screenshots with `driver.takeScreenshot()` and compares against PNG baselines
in `tests/visual/baselines/` using `pixelmatch`. Fails when pixel difference exceeds 1%
(configurable via `VISUAL_DIFF_THRESHOLD`). Run `test:visual:update` to regenerate.
Diff manifest written to `reports/visual/manifest.json`.

### Flaky detection (`tests/flaky/`)
Three tests that fail randomly ~30% of the time. Run repeatedly to build the flakiness
signal. Isolated — not matched by smoke/sanity/regression spec globs.

### Coverage upload (`coverage/`, `scripts/upload-coverage.js`)
Static Istanbul `coverage-summary.json` demonstrates the coverage-upload flow.
Requires `--run-id` to attach coverage to the correct test run in the dashboard.
In production, replace with `nyc report --reporter=json-summary` output.

### Release metadata
`FLAKEY_RELEASE` is forwarded through `process.env` in `scripts/upload-coverage.js`.
The backend coverage endpoint does not yet accept a `release` field — it will be picked
up automatically when support is added.
