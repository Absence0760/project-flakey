# Better Testing — Project Overview

## What is this?

A self-hosted, CI-agnostic test reporting dashboard that collects test reports from any framework (Cypress, Playwright, Jest, WebdriverIO, pytest, and more), normalizes them into a unified schema, stores them in PostgreSQL, and displays results in a Svelte frontend.

Multi-tenant with organization-based isolation enforced by Postgres Row-Level Security. JWT + API key authentication. No vendor lock-in. No per-test pricing.

## The problem it solves

Cypress Cloud is expensive and requires deep integration. Sorry Cypress and Currents.dev both needed live orchestration hooks that Cypress eventually blocked. Most teams that left Cypress Cloud have no good self-hosted alternative that:

- Works with any CI (Bitbucket Pipelines, GitHub Actions, GitLab CI, etc.)
- Supports multiple reporters (Mochawesome, JUnit, Playwright, Jest, WebdriverIO) not just Cypress-specific formats
- Provides parallel run merging, live progress, and smart spec balancing without requiring a coordination server
- Can be self-hosted for free
- Provides tenant isolation for teams/organizations

## Features

### Reporting
- **7 reporters**: Mochawesome (Cypress/Mocha), JUnit XML (Jest, pytest, Go, Java, .NET), Playwright JSON, Jest JSON, WebdriverIO JSON
- **Direct reporter plugins**: `@flakeytesting/cypress-reporter`, `@flakeytesting/playwright-reporter`, `@flakeytesting/webdriverio-reporter`
- **Live reporter**: `@flakeytesting/live-reporter` streams test progress in real-time during execution
- **Artifact management**: screenshots, videos, DOM snapshots — stored locally or on S3
- **CLI uploader**: finds report files, discovers screenshots/videos, uploads via multipart
- **Parallel run merging**: multiple CI workers with the same `ci_run_id` merge into a single run

### Dashboard
- **Metrics cards**: total runs, tests, pass rate, failures
- **Trend charts**: pass rate over time, test volume, run duration, top failing tests
- **Date range picker**: presets (today, 7d, 30d, 90d, 1yr) + custom calendar range
- **Suite health**: per-suite pass rate rings, trend indicators, comparison bars
- **Saved views**: save filter presets (suite, branch, search) for quick access
- **Live progress**: real-time test event feed on run detail pages during active runs
- **Dark/light mode**: toggle between light, dark, and system theme preference

### Runs List
- **Multi-filter**: suite, branch, status (passed/failed/new failures), date range (1h/today/24h/7d/30d), and text search
- **Spec file preview**: each run card shows the spec files that were run for easy identification
- **New failures badge**: amber badge highlights runs with regressions (tests that passed before but now fail)
- **Pinned runs**: pin runs for quick access during debugging sessions (persisted in localStorage)
- **Compare mode**: select two runs from the filtered list and compare side-by-side
- **Pagination**: load more runs on demand with accurate total counts
- **URL persistence**: all filter state is synced to the URL for bookmarkable/shareable views
- **Copy suite name**: quick copy button on each run card

### Test Analysis
- **Run detail**: progress ring, status filter tabs, test search, collapsible spec sections, prev/next run navigation
- **Auto-filter to failed**: runs with failures auto-filter to show only failed tests
- **Auto-expand failed specs**: failed specs start expanded, passing specs start collapsed
- **Sticky filter toolbar**: filter tabs stay pinned while scrolling long test lists
- **Copy buttons**: copy suite name, feature/spec name, scenario/test name, and error messages
- **Rerun commands**: per-suite configurable command template with `{spec}`, `{specs}`, `{title}`, `{suite}` placeholders; copy rerun command per failed test or all failed at once
- **Copy for tickets**: copy run summary formatted for Jira (wiki markup) or Markdown, including all test results with status icons
- **URL-based filter**: status filter persists in URL (`/runs/63?status=failed`) for shareable links
- **Error modal**: screenshots with lightbox, video player, Cypress command log, source code, expandable stack trace, keyboard navigation between failures
- **Error grouping**: failures aggregated by error message, filterable by suite/run, status tracking (open/investigating/known/fixed/ignored)
- **Flaky test detection**: identifies tests that alternate between pass and fail across runs, with timeline visualization
- **Slowest tests**: ranked by duration with P50/P95/P99 stats, trend analysis
- **Test history**: pass/fail timeline for individual tests across runs
- **Compare runs**: side-by-side diff showing regressions, fixes, unchanged

### Quality Metrics Beyond Pass/Fail
- **Code coverage tracking**: upload Istanbul-style `coverage-summary.json` per run; see lines/branches/functions/statements percentages with color-coded bars on the run detail page
- **PR coverage gating**: configurable minimum threshold that posts a pass/fail commit status on the PR (reuses the same git provider credentials as the PR comment integration)
- **Accessibility testing**: upload axe-core results per run; automatically scored (100 − weighted impact deductions) with per-impact breakdown (critical/serious/moderate/minor) and expandable violations list
- **Visual regression**: store baseline/current/diff image paths per screenshot with `pending | changed | approved | rejected | new | unchanged` workflow; reviewers can approve or reject directly from the run detail page
- **UI coverage mapping**: track which routes/pages tests actually visit and compare against a known-routes inventory to surface untested pages and an overall coverage percentage

### Manual & Release Management
- **Manual test management**: a unified platform for tracking manual regression tests alongside automated ones — steps, expected results, priority, status, execution history, and optional linkage to automated test keys. Supports hand-authored cases **and** bulk import of Cucumber `.feature` files, with imported scenarios auto-matched against the latest automated run so testers can see at a glance which cases are already covered (see [manual-tests.md](manual-tests.md))
- **Release checklists with sign-off**: create releases with a default checklist (critical tests passing, regression suite executed, release notes, docs, stakeholder notification, rollback plan); mark required items, track who checked what, and enforce "all required items complete" before sign-off is allowed

### Issue Tracking & Incident Integrations
- **Jira integration**: opt-in auto-creation of Jira issues for new test failures, deduplicated by test fingerprint; or manually open a ticket for a specific failure from the error view
- **PagerDuty integration**: fire Events API v2 incidents on run failure with configurable severity and per-suite dedup keys, so a flapping suite doesn't spam on-call
- **Scheduled reports**: deliver daily or weekly test-summary digests via email, Slack, or generic webhook; filterable by suite; scheduler uses a Postgres advisory lock so multi-replica backends don't double-fire
- **Secrets encryption at rest**: Jira API tokens and PagerDuty integration keys are encrypted with AES-256-GCM before being written to the database (key from `FLAKEY_ENCRYPTION_KEY`; gracefully falls back to plaintext in local dev if unset)

### AI-Powered Analysis
- **Failure classification**: auto-categorize errors as product bug, automation bug, environment issue, etc.
- **Error summaries**: AI-generated plain-English explanations with suggested fixes
- **Similar failure detection**: token-based similarity matching across error groups
- **Flaky test analysis**: root cause analysis and stabilization suggestions
- **Predictive test selection**: recommend which tests to run based on changed files
- **Flaky test quarantining**: isolate flaky tests so they don't block CI
- Supports Claude API or any OpenAI-compatible local model (Ollama, vLLM, LM Studio)

### CI/PR Integration
- **Commit status checks**: pass/fail status on commits for GitHub, GitLab, Bitbucket
- **PR comments**: test result summary posted as PR/MR comments, auto-updated on re-runs
- **Smart spec balancing**: split specs across CI workers balanced by historical duration
- **Auto-cancellation**: CI workers can check failure threshold and exit early
- **Webhook notifications**: Slack, Teams, Discord, or generic JSON on run failure, new failures, and flaky test detection

### Auth & Multi-tenancy
- **JWT authentication** for web sessions, **API keys** for CLI/programmatic access
- **Organization-based multi-tenancy** with Postgres Row-Level Security
- Data isolation enforced at the database level — even buggy application code can't leak data
- **Email verification** and **password reset** flow
- **Org switcher** in the sidebar for users in multiple organizations
- Invite flow: admins invite users by email, token-based accept
- Roles: owner, admin, viewer

### Deployment
- **Terraform**: AWS infrastructure (ECS Fargate, RDS, S3, CloudFront)
- **Helm chart**: Kubernetes deployment with bundled PostgreSQL option
- **Docker Compose**: local development
- **S3 storage adapter**: artifacts stored on S3 in production, local disk in development
- **GitHub Actions**: CI/CD pipelines for deploy and npm publishing

### Integrations
- **MCP server**: `@flakeytesting/mcp-server` for AI coding agents (Claude Code, Cursor, Copilot)
- **Git providers**: GitHub, GitLab, Bitbucket (PR comments + status checks)
- **Webhooks**: Slack (Block Kit), Teams (Adaptive Cards), Discord (Embeds), generic JSON
- **Status badges**: embeddable SVG badges for README files

## Data collected

- Full test results (suite tree, test results, durations, errors)
- Screenshots on failure
- Videos of the full run
- DOM snapshots (Cypress-specific, step-by-step HTML capture)
- Command logs (Cypress command history per test)
- Test source code
- Reporter-specific metadata (Playwright: retries, tags, annotations; JUnit: classname, properties; Jest: ancestor titles)
- Run metadata (branch, commit SHA, CI run ID, start/end time, reporter, suite name)
