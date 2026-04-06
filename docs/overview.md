# Flakey — Project Overview

## What is this?

A self-hosted, CI-agnostic test reporting dashboard that collects post-run test reports (mochawesome, JUnit XML, etc.), normalizes them into a unified schema, stores them in a database, and displays results in a Svelte frontend.

No vendor lock-in. No per-test pricing. No live orchestration server required.

## The problem it solves

Cypress Cloud is expensive and requires deep integration. Sorry Cypress and Currents.dev both needed live orchestration hooks that Cypress eventually blocked. Most teams that left Cypress Cloud have no good self-hosted alternative that:

- Works with any CI (Bitbucket Pipelines, GitHub Actions, GitLab CI, etc.)
- Accepts post-run reports rather than requiring a live connection during the run
- Supports multiple reporters (mochawesome, JUnit, etc.) not just Cypress-specific formats
- Can be self-hosted for free

## Why post-run upload works

You don't need live orchestration if your CI handles parallelization natively:

| Feature | Post-run upload | Live orchestration |
|---|---|---|
| Pass/fail reporting | ✅ | ✅ |
| Screenshots/videos | ✅ | ✅ |
| Historical trends | ✅ | ✅ |
| Flakiness detection | ✅ (over time) | ✅ |
| Parallel test splitting | ❌ | ✅ |
| Real-time run progress | ❌ | ✅ |

Bitbucket Pipelines `parallel` steps and GitHub Actions matrix strategy both handle parallel test splitting natively — so the only gap is real-time progress, which is rarely a hard requirement.

## Data collected post-run

- Full mochawesome JSON (suite tree, test results, durations, errors)
- Screenshots on failure (Cypress saves these automatically)
- Videos of the full run
- JUnit XML output
- Browser console logs (via cy.task + log collector)
- Run metadata (branch, commit SHA, CI run ID, start/end time)

## Name

**Flakey** — leans into flakiness detection as a core feature, memorable, has personality.

npm package: `flakey-reporter` — installable in any Cypress or Playwright project to send results directly to the Flakey API without needing intermediate report files.
