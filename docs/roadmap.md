# Roadmap

## Phase 1 — MVP (1–2 weeks)

Goal: working end-to-end pipeline from Cypress run to visible results.

- [ ] Node CLI uploader script
- [ ] Express API with `POST /runs` endpoint
- [ ] mochawesome parser + normalizer
- [ ] PostgreSQL schema (runs, specs, tests tables)
- [ ] Basic Svelte dashboard — run list + run detail view
- [ ] Test against real `encor-tests` Bitbucket pipeline

Milestone: a Cypress run in Bitbucket uploads its results and you can see pass/fail in a browser.

## Phase 2 — Multi-reporter + storage (1 week)

- [ ] JUnit XML parser
- [ ] Screenshot serving (store paths, serve via API or S3)
- [ ] Video serving
- [ ] Branch and suite filtering in the dashboard
- [ ] Run metadata (commit SHA, CI run ID, duration) displayed in UI

Milestone: works for both mochawesome and JUnit, screenshots visible on failure.

## Phase 3 — Trends + flakiness (2 weeks)

- [ ] Flakiness detection (spec/test that alternates pass/fail across runs)
- [ ] Trend charts — pass rate over time per suite
- [ ] Slowest tests view
- [ ] GitHub Actions integration example
- [ ] API authentication (token-based)
- [ ] Docker compose setup for self-hosting

Milestone: actionable insights beyond just pass/fail, usable by other teams.

## Phase 4 — Polish + open source (ongoing)

- [ ] Choose and finalize app name
- [ ] README with quick-start guide
- [ ] Docker image published to Docker Hub
- [ ] CI integration docs (Bitbucket, GitHub Actions, GitLab CI)
- [ ] Additional reporter parsers (Playwright, Jest, WebdriverIO)
- [ ] Slack/webhook notifications on failure

## What this will not do (by design)

- Live test orchestration (use CI-native parallelization instead)
- Real-time run progress during a run
- Replacing Cypress Cloud's paid parallelization features

These omissions are intentional. The CI matrix/parallel approach covers parallelization without needing a coordination server.
