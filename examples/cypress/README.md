# Cypress Example — Better Testing

This example wires the [`@flakeytesting/cypress-reporter`](../../packages/flakey-cypress-reporter),
[`@flakeytesting/cypress-snapshots`](../../packages/flakey-cypress-snapshots), and
[`@flakeytesting/live-reporter`](../../packages/flakey-live-reporter) packages into a standard
Cypress project that tests the shared todo-app fixture at `examples/shared/app`.

## Prerequisites

```
# Start the shared app (serves on http://localhost:4444)
cd examples/shared && pnpm start
```

Copy `.env.example` to `.env` and fill in `FLAKEY_API_URL` / `FLAKEY_API_KEY`.

## Test suites

| Script | What it runs |
|---|---|
| `pnpm test:smoke` | `cypress/e2e/smoke/**` — happy-path login + todos |
| `pnpm test:sanity` | `cypress/e2e/sanity/**` — broader sanity checks |
| `pnpm test:regression` | `cypress/e2e/regression/**` — regression scenarios |
| `pnpm test:live` | `cypress/e2e/live/**` — live-stream demo |
| `pnpm test:a11y` | `cypress/e2e/a11y/**` — accessibility scan |
| `pnpm test:flaky` | `cypress/e2e/flaky/**` — intentional flaky tests |
| `pnpm open` | Cypress interactive mode (all specs) |

## Features exercised

### DOM snapshots
`@flakeytesting/cypress-snapshots` is wired via `setupFlakey(on, config)` in `cypress.config.ts`
and imported in `cypress/support/e2e.ts`.  After each run the dashboard shows a step-by-step
HTML replay for every failing test.

### Flaky test detection
Run `pnpm test:flaky` repeatedly.  `cypress/e2e/flaky/intentionally-flaky.cy.ts` contains three
tests that randomly fail ~30 % of the time.  Once enough run history accumulates, Better Testing
surfaces them as flaky in the Flaky Tests view.

### Accessibility testing
`pnpm test:a11y` uses [`cypress-axe`](https://github.com/component-driven/cypress-axe) to inject
axe-core and scan the home page, login page, and todos page.  Violations are **logged** in the
Cypress command log but do not fail the suite (the `skipFailures` flag is `true`).  See
`cypress/e2e/a11y/app-a11y.cy.ts` for the comment-marked tradeoff and instructions for enabling
strict mode once the app's violations are resolved.

### Coverage upload
`scripts/collect-coverage.js` emits a static Istanbul `coverage-summary.json` (the example app is
not instrumented — see the script for real-coverage setup steps).  To upload coverage for a run:

```
FLAKEY_RUN_ID=<run-id> pnpm coverage:upload
```

The `coverage:upload` script generates the summary then calls
`flakey-upload coverage --run-id $FLAKEY_RUN_ID --file coverage/coverage-summary.json` which
POSTs to `POST /coverage` on the Better Testing backend.

### Live run streaming
`@flakeytesting/live-reporter` streams per-test events to the backend in real time.  Results
appear in the Live Runs view before the Cypress run finishes.  Screenshots stream the same way
via `after:screenshot` — each PNG POSTs to `POST /live/:runId/screenshot` the moment Cypress
writes it, then the local file is `unlink`'d on 2xx so a long failure-heavy suite can't fill the
runner's disk before `after:run` fires (the same pattern Cypress Cloud uses for per-spec
artifacts).  If streaming fails (no live run id, network blip), the file is retained and the
`after:run` batch picks it up.  DOM snapshots stream via `POST /live/:runId/snapshot` with the
same unlink-on-2xx contract.

### Environment tagging
Label which target the suite ran against (e.g. `qa`, `stage`, `prod`) so the dashboard can show
it as a chip and offer it as a filter.  Three equivalent routes — the reporter resolves any of
them (in this order: explicit `reporterOptions.environment` → `FLAKEY_ENV` → `TEST_ENV` →
`cypress --env environment=…` → `cypress --env name=…`):

```bash
# 1. dedicated env var
FLAKEY_ENV=qa pnpm test:smoke

# 2. via cypress's own --env (matches package.json scripts in the wild)
cypress run --env name=qa --spec cypress/e2e/smoke/**

# 3. explicit reporterOptions field in cypress.config.ts
reporterOptions: { url, apiKey, suite, environment: "qa" }
```

### Release metadata tagging
`FLAKEY_RELEASE` (read by the reporter at upload time) tags the run with a release version.  The
backend upserts the release on first sight and links every run with the same tag to it.  The
example's `cypress.config.ts` already wires `release: process.env.FLAKEY_RELEASE` through
`reporterOptions`, so set `FLAKEY_RELEASE=v1.2.3 pnpm test:smoke` and the run shows up under that
release in the dashboard.

### AI classification
Every uploaded run is eligible for AI-based failure classification on the Better Testing backend.
No extra Cypress config is required — classification runs server-side on the uploaded result.

### PR status / comments
Set `GITHUB_SHA` and `GITHUB_REF_NAME` environment variables (or their CI equivalents) and the
uploaded run will be linked to the corresponding commit / branch.  The backend creates PR
comments when a CI run is associated with an open pull request.
