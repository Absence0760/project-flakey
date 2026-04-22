# Jest example — Better Testing

Unit tests for the pure utility functions that back the sample app (`src/todo.ts`, `src/auth.ts`, `src/utils.ts`). Jest is a natural fit for testing library code — no browser, no server, fast feedback.

## What this example covers

- Uploading Jest results via the `flakey-upload` CLI (JUnit XML reporter)
- Uploading Istanbul coverage summaries via `flakey-upload coverage`
- Isolating intentionally flaky tests from the main CI run

## Structure

```
examples/jest/
  src/
    auth.ts         — login / email-validation utilities
    todo.ts         — todo CRUD helpers (create, toggle, filter, sort)
    utils.ts        — slugify, truncate, groupBy, formatDuration, retry
  __tests__/
    smoke/
      auth.test.ts  — happy-path auth tests
      todo.test.ts  — core todo operations
    regression/
      utils.test.ts       — full regression suite for utils
      todo-sort.test.ts   — priority-sort edge cases
    flaky/
      timing.test.ts      — intentionally flaky (~30% failure rate); excluded from default run
  scripts/
    upload.js           — upload JUnit results to Better Testing
    upload-coverage.js  — upload Istanbul coverage summary
  jest.config.js
  package.json
  tsconfig.json
```

## Quick start

### Prerequisites

- Better Testing backend running on `http://localhost:3000`
- An API key from Better Testing (Profile > API Keys)

### Install

```bash
cd examples/jest
pnpm install --ignore-workspace
```

The `--ignore-workspace` flag is required because the root `pnpm-workspace.yaml` only covers `packages/*`. This example has its own independent lockfile.

### Run smoke tests

```bash
FLAKEY_API_KEY=fk_your_key pnpm test:smoke
```

This runs `__tests__/smoke/**` with coverage, writes:
- `reports/junit.xml` — JUnit XML consumed by the CLI
- `coverage/smoke/coverage-summary.json` — Istanbul summary consumed by `coverage:upload`

### Upload results

```bash
# Upload JUnit results (creates a run in Better Testing, prints the run ID)
FLAKEY_API_KEY=fk_your_key node scripts/upload.js smoke

# Upload coverage for that run
RUN_ID=42 FLAKEY_API_KEY=fk_your_key node scripts/upload-coverage.js --coverage-dir coverage/smoke
```

### Run regression tests

```bash
FLAKEY_API_KEY=fk_your_key pnpm test:regression
FLAKEY_API_KEY=fk_your_key node scripts/upload.js regression
RUN_ID=43 FLAKEY_API_KEY=fk_your_key node scripts/upload-coverage.js --coverage-dir coverage/regression
```

### Run flaky tests

```bash
pnpm test:flaky
```

The flaky suite is excluded from `test:smoke` and `test:regression` via `testPathIgnorePatterns` in `jest.config.ts`. Run it separately to see the ~30% failure rate appear as a flaky pattern in the Better Testing dashboard after a few uploads.

## How the upload path works

### Test results (JUnit XML)

Jest does not have a built-in Better Testing reporter. Instead:

1. `jest-junit` writes a JUnit XML file to `reports/junit.xml` after each run (configured in `jest.config.ts`).
2. `flakey-upload` reads that XML and POSTs it to `/runs` (or `/runs/upload` when artifacts are present):

```
jest --reporters=default --reporters=jest-junit
     ↓ reports/junit.xml
flakey-upload --reporter junit --report-dir reports --suite jest-example-smoke
     ↓ POST /runs
```

The CLI detects `--reporter junit`, finds `.xml` files in `--report-dir`, and sends them as-is. See `packages/flakey-cli/src/index.ts` → `findReportFile()`.

### Coverage

Jest generates `coverage-summary.json` via Istanbul when `--coverage` and `coverageReporters: ["json-summary"]` are set. The `coverage` subcommand of `flakey-upload` normalises the Istanbul format and uploads to `/coverage`:

```
jest --coverage --coverageDirectory=coverage/smoke
     ↓ coverage/smoke/coverage-summary.json  (Istanbul format)
flakey-upload coverage --run-id 42 --file coverage/smoke/coverage-summary.json
     ↓ POST /coverage  { lines_pct, branches_pct, functions_pct, statements_pct, ... }
```

Coverage is attached to a specific run ID, so you must upload results first.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FLAKEY_API_KEY` | — | Required. API key for authentication. |
| `FLAKEY_API_URL` | `http://localhost:3000` | Better Testing backend URL. |
| `RUN_ID` | — | Run ID for coverage upload (from results upload output). |

Create a `.env` file in `examples/jest/` for local development:

```
FLAKEY_API_KEY=fk_your_key
FLAKEY_API_URL=http://localhost:3000
```

## All scripts

| Script | What it does |
|---|---|
| `pnpm test` | Run all tests (excludes `__tests__/flaky/`) |
| `pnpm test:smoke` | Smoke suite with coverage |
| `pnpm test:regression` | Regression suite with coverage |
| `pnpm test:flaky` | Flaky suite only (run standalone) |
| `pnpm upload` | Upload JUnit results (pass suite suffix as arg) |
| `pnpm coverage:upload` | Upload coverage summary (requires `RUN_ID`) |
