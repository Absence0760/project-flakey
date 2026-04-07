# Flakey — Project Overview

## What is this?

A self-hosted, CI-agnostic test reporting dashboard that collects post-run test reports (Mochawesome, JUnit XML, Playwright JSON), normalizes them into a unified schema, stores them in PostgreSQL, and displays results in a Svelte frontend.

Multi-tenant with organization-based isolation enforced by Postgres Row-Level Security. JWT + API key authentication. No vendor lock-in. No per-test pricing.

## The problem it solves

Cypress Cloud is expensive and requires deep integration. Sorry Cypress and Currents.dev both needed live orchestration hooks that Cypress eventually blocked. Most teams that left Cypress Cloud have no good self-hosted alternative that:

- Works with any CI (Bitbucket Pipelines, GitHub Actions, GitLab CI, etc.)
- Accepts post-run reports rather than requiring a live connection during the run
- Supports multiple reporters (Mochawesome, JUnit, Playwright) not just Cypress-specific formats
- Can be self-hosted for free
- Provides tenant isolation for teams/organizations

## Features

### Reporting
- **3 reporters**: Mochawesome (Cypress/Mocha), JUnit XML (Jest, pytest, Go, Java, .NET), Playwright JSON
- **Artifact management**: screenshots on failure, videos, stored on disk and served via API
- **CLI uploader**: finds report files, discovers screenshots/videos, uploads via multipart

### Dashboard
- **Metrics cards**: total runs, tests, pass rate, failures
- **Trend charts**: pass rate over time, test volume, run duration, top failing tests
- **Date range picker**: presets (today, 7d, 30d, 90d, 1yr) + custom calendar range
- **Recent runs & failures**: quick links to details

### Test Analysis
- **Run detail**: progress ring, status filter tabs, test search, collapsible spec sections
- **Error modal**: screenshots with lightbox, video player, Cypress command log, source code, expandable stack trace, keyboard navigation between failures
- **Error grouping**: failures aggregated by error message, filterable by suite/run
- **Flaky test detection**: identifies tests that alternate between pass and fail across runs

### Auth & Multi-tenancy
- **JWT authentication** for web sessions, **API keys** for CLI/programmatic access
- **Organization-based multi-tenancy** with Postgres Row-Level Security
- Data isolation enforced at the database level — even buggy application code can't leak data
- Invite flow: admins invite users by email, token-based accept
- Roles: owner, admin, member

## Why post-run upload works

You don't need live orchestration if your CI handles parallelization natively:

| Feature | Post-run upload | Live orchestration |
|---|---|---|
| Pass/fail reporting | Yes | Yes |
| Screenshots/videos | Yes | Yes |
| Historical trends | Yes | Yes |
| Flakiness detection | Yes | Yes |
| Parallel test splitting | No | Yes |
| Real-time run progress | No | Yes |

Bitbucket Pipelines `parallel` steps and GitHub Actions matrix strategy both handle parallel test splitting natively — so the only gap is real-time progress, which is rarely a hard requirement.

## Data collected post-run

- Full test results (suite tree, test results, durations, errors)
- Screenshots on failure (Cypress and Playwright save these automatically)
- Videos of the full run
- Command logs (Cypress command history per test)
- Test source code
- Run metadata (branch, commit SHA, CI run ID, start/end time, reporter, suite name)

## Name

**Flakey** — leans into flakiness detection as a core feature, memorable, has personality.
