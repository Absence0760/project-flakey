# Cypress + Cucumber Example — Better Testing

This example wires the [`@flakeytesting/cypress-reporter`](../../packages/flakey-cypress-reporter),
[`@flakeytesting/cypress-snapshots`](../../packages/flakey-cypress-snapshots), and
[`@flakeytesting/live-reporter`](../../packages/flakey-live-reporter) packages into a Cypress
project that uses [Cucumber](https://github.com/badeball/cypress-cucumber-preprocessor) for
Gherkin-style BDD specs.  The app under test is the shared todo-app fixture at
`examples/shared/app`.

## Prerequisites

```
# Start the shared app (serves on http://localhost:4444)
cd examples/shared && pnpm start
```

Copy `.env.example` to `.env` and fill in `FLAKEY_API_URL` / `FLAKEY_API_KEY`.

## Test suites

| Script | What it runs |
|---|---|
| `pnpm test` | Root `.feature` files + `requirements/` — standard + traceability suite |
| `pnpm test:smoke` | `cypress/e2e/*.feature` only — original happy-path scenarios |
| `pnpm test:a11y` | `cypress/e2e/a11y/**/*.feature` — accessibility scan |
| `pnpm test:flaky` | `cypress/e2e/flaky/**/*.feature` — intentional flaky scenarios |
| `pnpm open` | Cypress interactive mode (all feature files) |

## Features exercised

### DOM snapshots
`@flakeytesting/cypress-snapshots/cucumber` is imported in `cypress/support/e2e.ts` alongside the
standard snapshot support.  This inserts Gherkin step markers into the DOM snapshot bundle so the
dashboard can show which step each snapshot corresponds to.

### Flaky test detection
Run `pnpm test:flaky` repeatedly.  `cypress/e2e/flaky/intentionally-flaky.feature` has three
scenarios that each randomly fail ~30 % of the time via a `Math.random()` guard in the step
definition.  Once enough run history accumulates, Better Testing surfaces them as flaky.

### Accessibility testing
`pnpm test:a11y` uses [`cypress-axe`](https://github.com/component-driven/cypress-axe) with a
reusable Gherkin step:

```gherkin
Then the page should be accessible
```

The step is defined in `cypress/e2e/a11y/app-a11y.ts`.  Violations are **logged** but do not fail
the scenario (`skipFailures: true`).  The tradeoff is clearly comment-marked — flip `skipFailures`
to `false` once the app's violations are resolved.

### Requirements traceability
`cypress/e2e/requirements/requirements.feature` demonstrates requirement-ID tagging:

```gherkin
@req-CCF-123
Scenario: Add a todo (CCF-123 — user must be able to create tasks)
```

Cucumber tags like `@req-CCF-123` are included in the test result uploaded to Better Testing,
linking the scenario to the requirement in your issue tracker.  Use any ID format that matches
your convention (Jira, Linear, GitHub Issues, etc.).

### Live run streaming
`@flakeytesting/live-reporter` streams per-test events to the backend in real time.  Results
appear in the Live Runs view before the Cypress run finishes.  Screenshots stream the same way
via `after:screenshot` — each PNG is unlink'd locally on 2xx so a long failure-heavy suite can't
fill the runner's disk before `after:run` fires (Cypress Cloud parity).  DOM snapshots use the
same per-test streaming with the same unlink-on-2xx contract.

### Environment tagging
Label the target environment (e.g. `qa`, `stage`) on the run.  The reporter resolves any of:
`reporterOptions.environment` → `FLAKEY_ENV` → `TEST_ENV` → `cypress --env environment=…` →
`cypress --env name=…`.  The cucumber-style script convention `cypress run --env name=qa`
works out of the box.

### AI classification
Every uploaded run is eligible for AI-based failure classification on the Better Testing backend.
No extra Cypress config is required — classification runs server-side on the uploaded result.

### PR status / comments
Set `GITHUB_SHA` and `GITHUB_REF_NAME` environment variables (or their CI equivalents) and the
uploaded run will be linked to the corresponding commit / branch.  The backend creates PR
comments when a CI run is associated with an open pull request.
