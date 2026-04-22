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
appear in the Live Runs view before the Cypress run finishes.

### Release metadata tagging
`FlakeyReporterOptions` does not yet expose a `release` field.  When the reporter adds the field,
uncomment the `release` line in `cypress.config.ts` — the example already reads `FLAKEY_RELEASE`
from the environment so no further changes will be needed.

### AI classification
Every uploaded run is eligible for AI-based failure classification on the Better Testing backend.
No extra Cypress config is required — classification runs server-side on the uploaded result.

### PR status / comments
Set `GITHUB_SHA` and `GITHUB_REF_NAME` environment variables (or their CI equivalents) and the
uploaded run will be linked to the corresponding commit / branch.  The backend creates PR
comments when a CI run is associated with an open pull request.
