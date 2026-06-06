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
- [x] GitHub Actions npm publish pipeline (@flakeytesting/cli, @flakeytesting/cypress-snapshots)
- [x] CI integration examples (GitHub Actions, Bitbucket Pipelines)
- [x] S3 storage adapter for artifacts (currently local disk)
- [x] Helm chart for Kubernetes

## Phase 6 — Advanced features

- [x] DOM snapshot plugin for Cypress (`@flakeytesting/cypress-snapshots`)
- [x] Test history per test (pass/fail timeline across runs)
- [x] Compare runs side-by-side
- [x] Additional reporter parsers (Jest, WebdriverIO)
- [x] Flaky test webhook notifications
- [x] Custom dashboards / saved filters

## Phase 7 — CI/PR integration

- [x] GitHub PR status checks (pass/fail the PR based on test results)
- [x] GitHub PR comments with test result summary
- [x] GitLab merge request integration
- [x] Bitbucket PR integration

## Phase 8 — Intelligent analysis

- [x] AI failure classification (auto-categorize: product bug, automation bug, system issue)
- [x] ML-based failure pattern recognition (surface historically similar failures)
- [x] AI-generated error summaries with probable root causes
- [x] Flaky test quarantining (isolate flaky tests so they don't block CI)
- [x] Predictive test selection (ML picks which tests to run based on code changes)

## Phase 9 — Integrations + workflows

- [x] Jira integration (auto-create tickets from failures, link results to issues)
- [x] PagerDuty integration (trigger incidents from test failures)
- [x] Scheduled reports (daily/weekly email or Slack digests)
- [x] Code coverage tracking with PR gating
- [x] MCP server for AI coding agent integration (Copilot, Cursor, Claude Code)

## Phase 10 — Extended testing capabilities

- [x] Accessibility testing (auto-check with historical scores and trend tracking)
- [x] Visual regression testing support
- [x] UI coverage mapping (identify untested pages/components)
- [x] Manual + automated test management (unified platform)
- [x] Release checklists with sign-off workflows

## Phase 11 — Release-grade test execution

- [x] Manual test groups (bulk-link by group to a release)
- [x] Xray-style test sessions per release (full / failures-only cycles with history)
- [x] Accept-as-known-issue for failed results (deferred against a bug ref)
- [x] One-click Jira bug filing from a failed session result
- [x] Requirements traceability (Jira/GitHub/Linear) with per-release coverage rollup
- [x] Step-level evidence attachments (screenshots, files)
- [x] Per-test assignees + session target dates
- [x] Manual-test flakiness signals derived from session history

## Phase 12 — Realtime dashboard UX

- [x] Replace dashboard `/live/active` polling with an org-scoped SSE subscription. Backend exposes `GET /live/stream` — sends an initial `snapshot` event with the active-run ids for the caller's org, then streams `active.add` / `active.remove` deltas as runs enter / leave the set. Dashboard (`+page.svelte`) subscribes once on mount and refetches the runs list on each delta instead of polling every 5 s. Closes the visible-latency gap from issue #41.

## Phase 13 — Cypress failure diagnostics

Deepen what we capture and expose for diagnosing a *Cypress* red. Today the
reporter records only error message/stack, screenshots, video, and snapshot
paths, and drops non-final retry attempts (`flakey-cypress-reporter/src/reporter.ts:254`) —
so the data a Cypress failure actually needs (what the page/app was doing) is
mostly absent. Ordered by leverage; the capture work feeds the query tools and
skills below it.

- [ ] **Cypress failure-context capture** — the Cypress counterpart to the Playwright trace→command-log already built in `@flakeytesting/playwright-snapshots`. Touches `@flakeytesting/cypress-reporter` (+ an injected support file), the normalizer, and a new `tests`-row column (migration + type-sync across `backend/src/types.ts` and `frontend/src/lib/api.ts`):
  - Command-log tail — the last N `cy.*` commands (and their per-command retries) before the failure.
  - Browser console output + uncaught exceptions / unhandled rejections at failure time (a large share of Cypress reds are really an app `window.onerror`, not a bad selector).
  - Network log — failed `cy.intercept`/XHRs around the failure ("the API 500'd," not "the element never appeared").
  - Retry-attempt trail — retain each attempt's error (still uncounted, preserving the `reporter.ts:254` behavior) so the delta between a failing and a passing attempt is available to classify the flake.
- [ ] **Evidence-pulling MCP tools** (thin wrappers over existing routes, complementing the 9 read tools in `flakey-mcp-server`): `get_test_artifacts(runId, testId)` (screenshot/video/snapshot URLs + command-log/console/network for one failure), `compare_runs(a, b)` (expose `/compare` — newly-failed / flipped), `get_similar_failures(fingerprint)` (expose `/analyze/similar`).
- [ ] **Cypress repro + triage skills** — the Cypress counterpart to the Playwright-only `flake-doctor`: `/cypress-repro <run|spec>` (resolve the failing spec from a run id and run it deterministically against `examples/cypress`, retries off + video on) and `/cypress-diagnose <runId>` (pull error + artifacts + command-log + similar failures, then classify the failure — selector drift / timing / app error / network / data collision — with a heuristic, provider-free first pass).
- [ ] **Reporter payload replay CLI** — feed a captured Cypress/mochawesome JSON straight through `parseMochawesome` + the upload path and dump the normalized result, for a sub-second loop on ingestion bugs without standing up the stack.
- [ ] **Source-map stack resolution** — resolve Cypress stack frames (bundled code) back to the real spec line so a failure points at *where in the test* it threw.

## What this will not do (by design)

- Live test orchestration (use CI-native parallelization instead)
- Replacing Cypress Cloud's paid parallelization features

These omissions are intentional. The CI matrix/parallel approach covers parallelization without needing a coordination server.
