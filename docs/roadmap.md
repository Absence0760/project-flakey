# Roadmap

## Phase 1 — MVP

Goal: working end-to-end pipeline from Cypress run to visible results.

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
- [x] Video serving
- [x] Branch and suite filtering in the dashboard
- [x] Run metadata (commit SHA, CI run ID, duration) displayed in UI
- [x] Error modal with screenshots, video, command log, source code, stack trace
- [x] Flaky test detection (tests that alternate pass/fail across runs)

## Phase 3 — Analytics + auth + multi-tenancy

- [x] Trend charts — pass rate over time, test volume, run duration, top failures
- [x] Date range picker with presets and calendar
- [x] Dashboard metrics cards (total runs, tests, pass rate, failures)
- [x] API authentication (JWT + API key)
- [x] User registration and login
- [x] Multi-tenancy with Postgres Row-Level Security
- [x] Organization management (create, invite members, roles)
- [x] API key management (create, list, delete) in Profile page
- [x] Configurable API URL via environment variable
- [x] Seed script with realistic multi-org data
- [ ] Slowest tests view
- [ ] GitHub Actions integration docs

## Phase 4 — Polish + hardening

- [ ] Rate limiting on auth endpoints
- [ ] httpOnly cookie token storage (replace localStorage)
- [ ] Email verification for registration
- [ ] Password reset flow
- [ ] Security headers (helmet.js)
- [ ] Org settings page (rename, manage invites)
- [ ] Org switcher in the frontend sidebar
- [ ] README with quick-start guide
- [ ] Docker image published to Docker Hub
- [ ] CI integration examples (Bitbucket, GitHub Actions, GitLab CI)

## Phase 5 — Advanced features

- [ ] DOM snapshot plugin for Cypress (see `cypress-snapshot-plugin.md`)
- [ ] Slack/webhook notifications on failure
- [ ] S3/cloud storage for artifacts
- [ ] Additional reporter parsers (Jest, WebdriverIO)
- [ ] Test history per test (pass/fail timeline)
- [ ] Compare runs side-by-side
- [ ] Customizable retention policies

## What this will not do (by design)

- Live test orchestration (use CI-native parallelization instead)
- Real-time run progress during a run
- Replacing Cypress Cloud's paid parallelization features

These omissions are intentional. The CI matrix/parallel approach covers parallelization without needing a coordination server.
