# Better Testing — Playwright example

Integration example wiring `@flakeytesting/playwright-reporter` into a Playwright project.
The example app is a simple todo/login SPA served locally from `examples/shared/app/` on port 4444.

## Quick start

```sh
# Start the example app (port 4444)
node examples/shared/app/serve.js &

# Install dependencies
cd examples/playwright
pnpm install

# Run smoke tests
pnpm test:smoke
```

## Features exercised

### Core test reporting

The reporter (`@flakeytesting/playwright-reporter`) uploads results, screenshots, and
videos to the Better Testing backend after each suite run. Set `FLAKEY_API_URL` and
`FLAKEY_API_KEY` before running.

### DOM snapshot replay

Playwright traces are parsed by `@flakeytesting/playwright-snapshots` to extract
per-step DOM snapshots and command logs. These are written to `playwright-snapshots/`
at runtime and uploaded alongside test results. `trace: "on"` in the config enables this.

### Accessibility scanning (`test:a11y`)

`tests/a11y/app-a11y.spec.ts` runs an axe-core scan (wcag2a + wcag2aa) against the login
and todos routes via `@axe-core/playwright`. Violations are logged to the console but do
not hard-fail the test. To enforce a zero-violation gate, uncomment the assertion in the
spec file.

```sh
pnpm test:a11y
```

### Visual regression (`test:visual`)

`tests/visual/app-visual.spec.ts` uses Playwright's built-in `toHaveScreenshot` to
compare the login page, empty todos, and todos-with-items views against committed
baselines in `tests/visual/app-visual.spec.ts-snapshots/`.

```sh
pnpm test:visual                 # compare against baselines
pnpm test:visual:update          # regenerate baselines after intentional UI changes
```

### Flaky detection (`test:flaky`)

`tests/flaky/intentionally-flaky.spec.ts` contains 3 tests that randomly fail ~30% of
the time. Running this suite repeatedly demonstrates how the Better Testing dashboard
surfaces flaky patterns. This folder is excluded from all other suites.

```sh
pnpm test:flaky
```

### Coverage upload (`coverage:upload`)

A static `coverage/coverage-summary.json` (Istanbul format) is committed as a demo
fixture. Upload it to the backend:

```sh
FLAKEY_API_URL=http://localhost:3000 FLAKEY_API_KEY=your_key \
  pnpm coverage:upload --run-id <run-id>
```

The `flakey-upload coverage` subcommand accepts `--run-id` and `--file` flags.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | — | API key for authentication |
| `SUITE` | `default` | Selects test directory (smoke/sanity/regression/a11y/visual/flaky) |

## Available scripts

| Script | What it runs |
|---|---|
| `pnpm test:smoke` | `tests/smoke/` |
| `pnpm test:sanity` | `tests/sanity/` |
| `pnpm test:regression` | `tests/regression/` |
| `pnpm test:a11y` | `tests/a11y/` (axe-core, log-only) |
| `pnpm test:visual` | `tests/visual/` (screenshot diff) |
| `pnpm test:visual:update` | Regenerate visual baselines |
| `pnpm test:flaky` | `tests/flaky/` (intentionally flaky) |
| `pnpm coverage:upload` | Upload `coverage/coverage-summary.json` |
