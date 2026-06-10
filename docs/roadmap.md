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
- [x] GitHub Actions deploy pipeline (release-triggered on an `app@<version>` tag; deploy-backend → deploy-frontend)
- [x] GitHub Actions npm publish pipeline (all @flakeytesting/* packages)
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

- [x] **Cypress failure-context capture** — the Cypress counterpart to the Playwright trace→command-log already built in `@flakeytesting/playwright-snapshots`. Touches `@flakeytesting/cypress-reporter` (+ an injected support file), the normalizer, and a new `tests`-row column (migration + type-sync across `backend/src/types.ts` and `frontend/src/lib/api.ts`):
  - Command-log tail — the last N `cy.*` commands (and their per-command retries) before the failure.
  - Browser console output + uncaught exceptions / unhandled rejections at failure time (a large share of Cypress reds are really an app `window.onerror`, not a bad selector).
  - Network log — failed `cy.intercept`/XHRs around the failure ("the API 500'd," not "the element never appeared").
  - Retry-attempt trail — retain each attempt's error (still uncounted, preserving the `reporter.ts:254` behavior) so the delta between a failing and a passing attempt is available to classify the flake.
- [x] **Evidence-pulling MCP tools** (thin wrappers over existing routes, complementing the 10 read tools in `flakey-mcp-server`): `get_test_artifacts(runId, testId)` (screenshot/video/snapshot URLs + command-log/console/network for one failure), `compare_runs(a, b)` (expose `/compare` — newly-failed / flipped), `get_similar_failures(fingerprint)` (expose `/analyze/similar`).
- [x] **Cypress repro + triage skills** — the Cypress counterpart to the Playwright-only `flake-doctor`: `/cypress-repro <run|spec>` (resolve the failing spec from a run id and run it deterministically against `examples/cypress`, retries off + video on) and `/cypress-diagnose <runId>` (pull error + artifacts + command-log + similar failures, then classify the failure — selector drift / timing / app error / network / data collision — with a heuristic, provider-free first pass).
- [x] **Reporter payload replay CLI** — feed a captured Cypress/mochawesome JSON straight through `parseMochawesome` + the upload path and dump the normalized result, for a sub-second loop on ingestion bugs without standing up the stack.
- [x] **Source-map stack resolution** — resolve Cypress stack frames (bundled code) back to the real spec line so a failure points at *where in the test* it threw.
- [x] **Snapshot step enrichment** — surface the captured diagnostics next to the steps. *(All phases built — see [proposals/phase-17-snapshot-step-enrichment.md](proposals/phase-17-snapshot-step-enrichment.md). Ships on the next `@flakeytesting/playwright-snapshots` + `@flakeytesting/cypress-snapshots` publish.)*
  - [x] Render the Cypress `failure_context` (console / network / uncaught / retry) in the error-modal Details tab — it was captured + stored + typed but shown nowhere.
  - [x] Playwright: attach per-step `console[]` / `network[]` to each snapshot step (extract the trace's inline console events + the separate `trace.network` file we previously dropped).
  - [x] Per-step UI — console/network strip in the snapshot viewer + at-a-glance error/failure badges on step rows.
  - [x] Cypress per-step capture — `instrumentWindow` wraps the app window's console/fetch/XHR and buffers each into the active step (`@flakeytesting/cypress-snapshots`), independent of the reporter's test-level `failure_context` wrapping.

## Phase 14 — Enterprise, compliance & contract hardening

Gaps that matter most for a self-hosted product run in a SOC 2 / GovRAMP
context, plus the one change that removes the repo's biggest internal footgun.

> **Status (this pass):** the non-compliance-gated items are landed; the SOC 2 /
> GovRAMP-scoped auth + logging controls and the high-risk migration are
> deliberately **deferred pending CISO / Security Analyst (and ops) review** —
> see [docs/proposals/phase-14-sso.md](proposals/phase-14-sso.md).

### Compliance & enterprise auth

- [ ] **SSO — SAML / OIDC login + SCIM provisioning.** Auth today is JWT + API keys + email/password only (`backend/src/routes/auth.ts`). Add IdP-backed single sign-on and automated user/role provisioning so enterprise and GovRAMP buyers can onboard against their own directory. Biggest single gap for that segment. *(Deferred — CISO sign-off required. Design + local Keycloak/Authentik IdPs + passing OIDC & SCIM e2e proofs are committed — see [proposal](proposals/phase-14-sso.md) and `frontend/tests-e2e/sso/`.)*
  - [x] **Dedicated SSO e2e CI job.** The `sso/` Playwright suite is excluded from the main Tests workflow (`frontend/tests-e2e/playwright.config.ts` ignores `**/sso/**`) because it hard-requires the opt-in IdP stack (Keycloak `:8081`, Authentik `:9002`, the mock SCIM target `:8082`) plus `FLAKEY_SSO_ENABLED` — none of which the main e2e job provisions. Now covered by a separate `.github/workflows/sso-e2e.yml` job that stands up that stack (from the same compose definitions) and runs all three specs (OIDC contract + SCIM via `playwright.sso.config.ts`, full-app OIDC login via `playwright.sso-app.config.ts`). Runs on every push to `main` plus SSO-path-touching PRs, so login + provisioning keep continuous regression coverage instead of a local-only proof.
- [x] **Audit-log export / SIEM streaming.** Tamper-evidence (per-org SHA-256 hash chain over `audit_log` + `GET /audit/verify`) and durable, gap-free, at-least-once export to a customer SIEM (HTTP) or S3, behind the `FLAKEY_AUDIT_EXPORT_ENABLED` instance flag (OFF by default). Migration `064`; `src/audit-chain.ts` + `src/audit-export.ts`; `/audit/verify` + `/audit/export` routes. Design: [proposals/phase-16-audit-logging-controls.md](proposals/phase-16-audit-logging-controls.md); operator guide: [backend/docs/audit-logging.md](../backend/docs/audit-logging.md). *(Built; enabling export in a regulated env still requires CISO sign-off.)*
  - [ ] **Audit-export admin UI.** Export destinations are API/IaC-configured today (admin+ `/audit/export` CRUD + `/audit/verify`). Add a `settings/audit-export` page (matching `settings/sso`) to configure destinations, rotate the token, run the test probe, and surface the chain-verify result — so it doesn't require curl.
  - [ ] **CloudWatch Logs destination.** The export adapter interface supports it; CloudWatch needs a new AWS SDK client + a local equivalent before it fits the local-first rule (HTTP + S3 shipped).
- [ ] **Connect-time SSRF pin for the notification-webhook dispatcher.** `src/webhooks.ts` `sendWebhook` validates only the hostname string at config-write time, so a public hostname resolving to a private/metadata IP is a (blind, credential-less) SSRF at send time. The audit-export delivery path already uses the connect-time pin `webhookSafeFetch` (`src/routes/webhooks.ts`) + `redirect:"manual"`; apply it to `sendWebhook` too. Needs a test-strategy change — `webhook_dispatch.unit.test.ts` swaps `globalThis.fetch`, which the custom-dispatcher fetch bypasses (use a real local server like `audit_export_ssrf.smoke.test.ts`, or undici interception).
- [~] **Self-hoster backup & DR runbook + at-rest posture.** Document backup/restore and disaster recovery for the RDS + S3 footprint, the encryption-at-rest story, and add a secret-rotation UI on top of the existing `npm run rotate-keys` CLI. *(Runbook + at-rest posture **done** — [docs/operations/backup-and-dr.md](operations/backup-and-dr.md). Secret-rotation UI deferred — security review.)*

### API contract

- [~] **Publish an OpenAPI spec + generate the client types.** The repo's documented footgun is "no type codegen — types are hand-synced across `backend/src/types.ts`, `frontend/src/lib/api.ts`, and the DB." An OpenAPI source-of-truth with a generated client eliminates that whole drift class (the `endpoint-inventory` skill exists today precisely because there is no published spec) and gives external integrators a real contract. *(**Done (seed):** `backend/openapi.yaml` + `pnpm openapi:generate`/`openapi:check` → `frontend/src/lib/api-generated.ts`, covering the core routes. Extend the spec to the remaining routes + migrate call sites as follow-up.)*

### Broader adoption

- [~] **More native reporters: pytest, Go `test`, .NET (xUnit / NUnit), RSpec.** The current set is JS-centric (mochawesome / JUnit / Playwright / Jest / WebdriverIO). JUnit XML covers some non-JS runners, but first-class reporters (live events + artifacts) win those ecosystems. *(**pytest done** as the reference — `packages/flakey-pytest-reporter/`. Go / .NET / RSpec follow-up.)*
- [x] **Rich GitHub Checks annotations.** Beyond the existing PR status check + summary comment, surface per-failure inline annotations on the diff via the Checks API so failures land at the offending line.

### Scale

- [~] **Artifact lifecycle / TTL on S3 + table partitioning for `runs`/`tests`.** Keep storage cost bounded (artifact TTL/dedup aligned with per-org retention) and keep queries fast on large orgs (time-based partitioning of the high-volume tables). *(**Artifact TTL done** — configurable S3 lifecycle + abort-incomplete-uploads, aligned with the existing per-org retention delete. Table partitioning deferred — downtime-class migration, ops review.)*

## Phase 15 — Failure triage workflow

Turn the **error group** into a first-class triage unit with ownership and an
automated lifecycle — not a Jira replacement. We already group automated
failures by a stable fingerprint (`error_groups`), give each group a status
(`open/investigating/known/fixed/ignored`), thread notes on it, and link it to a
Jira ticket (`failure_jira_issues`). What's missing is everything that only
makes sense *because we hold the run data*: who owns a failure, when it's due,
whether a "fixed" failure **came back**, and whether a green test should close
the loop. Design rule: **if it needs the run data (recurrence, auto-close,
flake-driven priority), build it; if it's generic issue tracking (sprints,
boards, custom fields), integrate — don't rebuild.** Full scope, build order, and
the trust-boundary review gate: see
[docs/proposals/phase-15-failure-triage.md](proposals/phase-15-failure-triage.md).

- [ ] **15.1 — Ownership & lifecycle foundation.** Additive columns on
  `error_groups` (`assigned_to`, `target_date`, `priority`) + assign / triage-update
  routes mirroring the proven manual-session assign shape; `/errors` becomes the
  triage surface (assignee picker, due date, "assigned to me" / "overdue"
  filters). Fully additive — no core-table or RLS change.
- [ ] **15.2 — Data-native automation (the moat).** Recurrence detection at
  ingest (a `fixed` fingerprint reappearing auto-transitions to a new `regressed`
  state, bumps `recurrence_count`, fires `error.regressed`); opt-in
  auto-close-on-green via the existing nightly retention pass; read-time derived
  priority from occurrence + flaky signal. The part no SaaS tracker can do.
- [ ] **15.3 — Quarantine lifecycle.** Add `expires_at` + fingerprint link to
  `quarantined_tests` (today quarantines never expire and rot silently); expire on
  the nightly sweep; surface "muted, expiring / no-expiry" in triage; the
  `flaky.detected` signal *suggests* (never auto-applies) quarantine.
- [ ] **15.4 — Two-way Jira sync.** Outbound: fix/regression transitions reflect
  onto the linked Jira issue (Jira can't do this — it has no run data). Inbound: an
  HMAC-verified `POST /jira/webhook` reflects Jira-close back to the group.
  *Inbound is a new external trust boundary — CISO / Security Analyst sign-off
  required before landing (SOC 2 / GovRAMP).*

## What this will not do (by design)

- Live test orchestration (use CI-native parallelization instead)
- Replacing Cypress Cloud's paid parallelization features

These omissions are intentional. The CI matrix/parallel approach covers parallelization without needing a coordination server.
