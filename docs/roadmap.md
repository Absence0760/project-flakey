# Roadmap

## Phase 1 — MVP

- [x] Node CLI uploader script
- [x] Express API with `POST /runs` endpoint
- [x] Mochawesome parser + normalizer
- [x] PostgreSQL schema (runs, specs, tests tables)
- [x] Basic Svelte dashboard — run list + run detail view
- [x] Docker Compose setup for local development

## Phase 2 — Multi-reporter + artifacts

- [x] JUnit XML parser
- [x] Playwright JSON parser
- [x] Screenshot serving (stored on disk, served via static middleware)
- [x] Video serving (mp4 + webm)
- [x] Playwright attachment extraction (auto-discover screenshots/videos from report)
- [x] Branch and suite filtering in the dashboard
- [x] Run metadata (commit SHA, CI run ID, duration) displayed in UI
- [x] Error modal with screenshots, video, command log, source code, stack trace
- [x] Flaky test detection (tests that alternate pass/fail across runs)
- [x] Reporter-specific metadata (Playwright: retries, tags, annotations, stdout; JUnit: classname, error_type, properties)

## Phase 3 — Analytics + auth + multi-tenancy

- [x] Trend charts — pass rate over time, test volume, run duration, top failures
- [x] Date range picker with presets and calendar
- [x] Dashboard metrics cards (total runs, tests, pass rate, failures)
- [x] API authentication (JWT + API keys + httpOnly cookies)
- [x] Refresh tokens (1hr access + 7d refresh)
- [x] User registration and login
- [x] Multi-tenancy with Postgres Row-Level Security
- [x] Organization management (create, invite members, roles: owner/admin/viewer)
- [x] API key management (create, list, delete) in Profile page
- [x] Configurable API URL via environment variable
- [x] Seed script with realistic multi-org data (mochawesome + playwright + junit)

## Phase 4 — Admin + hardening

- [x] Rate limiting on auth endpoints (20 req / 15 min)
- [x] httpOnly cookie token storage
- [x] Controlled registration (invite-only mode via `ALLOW_REGISTRATION=false`)
- [x] CORS whitelist in production (`CORS_ORIGINS` env var)
- [x] JWT secret validation (refuses to start without it in production)
- [x] Bcrypt cost factor 12, 8-char minimum password
- [x] Audit log (tracks all mutations: uploads, settings, members, webhooks)
- [x] Suite management (rename, archive, delete)
- [x] Data retention (auto-delete runs older than N days per org)
- [x] Webhook notifications (Slack/Teams/Discord on run failure)
- [x] Team management UI (invite, change roles, remove members)
- [x] Resizable split panes in error modal
- [x] Zoomable/pannable screenshot lightbox
- [x] Slowest tests view
- [x] Security headers (helmet.js)
- [x] README with quick-start guide
- [x] Email verification for registration
- [x] Password reset flow
- [x] Org switcher in the frontend sidebar

## Phase 5 — Deployment + distribution

- [x] Terraform infrastructure (AWS: ECS Fargate, RDS, S3, CloudFront)
- [x] Backend Dockerfile
- [x] Frontend static hosting on S3/CloudFront (no Docker needed)
- [x] GitHub Actions deploy pipeline (path-filtered, backend + frontend independent)
- [x] GitHub Actions npm publish pipeline (@flakey/cli, @flakey/cypress-snapshots)
- [x] CI integration examples (GitHub Actions, Bitbucket Pipelines)
- [ ] S3 storage adapter for artifacts (currently local disk)
- [ ] Helm chart for Kubernetes

## Phase 6 — Advanced features

- [x] DOM snapshot plugin for Cypress (`@flakey/cypress-snapshots`)
- [x] Test history per test (pass/fail timeline across runs)
- [x] Compare runs side-by-side
- [ ] Additional reporter parsers (Jest, WebdriverIO)
- [ ] Flaky test webhook notifications
- [ ] Custom dashboards / saved filters

## Phase 7 — CI/PR integration

- [ ] GitHub PR status checks (pass/fail the PR based on test results)
- [ ] GitHub PR comments with test result summary
- [ ] GitLab merge request integration
- [ ] Bitbucket PR integration

## Phase 8 — Intelligent analysis

- [ ] AI failure classification (auto-categorize: product bug, automation bug, system issue)
- [ ] ML-based failure pattern recognition (surface historically similar failures)
- [ ] AI-generated error summaries with probable root causes
- [ ] Flaky test quarantining (isolate flaky tests so they don't block CI)
- [ ] Predictive test selection (ML picks which tests to run based on code changes)

## Phase 9 — Integrations + workflows

- [ ] Jira integration (auto-create tickets from failures, link results to issues)
- [ ] PagerDuty integration (trigger incidents from test failures)
- [ ] Scheduled reports (daily/weekly email or Slack digests)
- [ ] Code coverage tracking with PR gating
- [ ] MCP server for AI coding agent integration (Copilot, Cursor, Claude Code)

## Phase 10 — Extended testing capabilities

- [ ] Accessibility testing (auto-check with historical scores and trend tracking)
- [ ] Visual regression testing support
- [ ] UI coverage mapping (identify untested pages/components)
- [ ] Manual + automated test management (unified platform)
- [ ] Release checklists with sign-off workflows

## What this will not do (by design)

- Live test orchestration (use CI-native parallelization instead)
- Real-time run progress during a run
- Replacing Cypress Cloud's paid parallelization features

These omissions are intentional. The CI matrix/parallel approach covers parallelization without needing a coordination server.
