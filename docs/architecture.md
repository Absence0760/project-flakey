# Architecture

## Stack

| Layer | Technology |
|---|---|
| Test runner | Cypress, Playwright, Jest, WebdriverIO, or any framework |
| Reporters | Mochawesome (JSON), JUnit (XML), Playwright (JSON), Jest (JSON), WebdriverIO (JSON) |
| Shared core | `@flakeytesting/core` (API client + schema) |
| Upload CLI | `@flakeytesting/cli` (npm package, `packages/flakey-cli`) |
| Cypress reporter | `@flakeytesting/cypress-reporter` (npm package) |
| Playwright reporter | `@flakeytesting/playwright-reporter` (npm package) |
| WebdriverIO reporter | `@flakeytesting/webdriverio-reporter` (npm package) |
| Live reporter | `@flakeytesting/live-reporter` (real-time test event streaming) |
| Snapshot plugins | `@flakeytesting/cypress-snapshots`, `@flakeytesting/playwright-snapshots` |
| MCP server | `@flakeytesting/mcp-server` (AI coding agent integration) |
| Backend API | Node.js + Express |
| Normalizer | Per-reporter parser -> unified schema |
| AI analysis | Claude API or OpenAI-compatible (Ollama, vLLM) |
| Database | PostgreSQL 16 with Row-Level Security |
| Auth | JWT + API keys, bcrypt, httpOnly cookies, refresh tokens, email verification |
| Multi-tenancy | Organization-based isolation via Postgres RLS |
| Frontend | SvelteKit (Svelte 5), static-hosted on S3/CloudFront |
| Storage | Local disk or S3 (configurable via `STORAGE` env var) |
| Infrastructure | Terraform (AWS: ECS Fargate, RDS, S3, CloudFront) + Helm chart (Kubernetes) |
| CI/CD | GitHub Actions (deploy + npm publish) |

## System flow

```
Test run starts
        |
        ├── Live reporter (optional): POST /live/start → numeric runId returned
        |       │ • writes runId to $TMPDIR/flakey-reporter/live-run-id (cross-process bridge for sibling plugins)
        |       │ • sets process.env.FLAKEY_API_URL / FLAKEY_API_KEY / FLAKEY_LIVE_RUN_ID
        |       |
        |       ├── POST /live/:runId/events  → SSE to frontend + upserts tests rows in real time
        |       |     • test.started → inserts tests row with status='pending'
        |       |     • test.passed/failed/skipped → updates that row
        |       |
        |       ├── POST /live/:runId/snapshot (cypress-snapshots, mid-test)
        |       |     • stores to runs/{id}/snapshots/… in S3 / local disk
        |       |     • updates tests.snapshot_path by full_title match
        |       |     • plugin unlinks local file on 2xx; retained on failure
        |       |
        |       ├── POST /live/:runId/screenshot (cypress-reporter, after:screenshot)
        |       |     • stores to runs/{id}/screenshots/… in S3 / local disk
        |       |     • appends to tests.screenshot_paths by full_title match
        |       |     • plugin unlinks local file on 2xx (CI disk-space guard);
        |       |       retained on failure for the after:run batch fallback
        |       |     • streamed paths are preserved across the end-of-run
        |       |       merge (uploads.ts + runs.ts both snapshot existing
        |       |       screenshot_paths before the test delete+reinsert)
        |       |
        |       ├── periodic empty-body POST /live/:runId/events (heartbeat)
        |       |     • LiveEventBus.touch() resets lastEventAt without emitting
        |       |     • prevents stale-run auto-abort during long quiet
        |       |       scenarios (slow Cucumber test, large cy.wait, etc.)
        |       |
        |       ├── GET /live/:runId/history (catch-up: list events emitted so far)
        |       ├── GET /live/active (active run ids in the org — fuels the
        |       |     dashboard's "running now" badge)
        |       ├── GET /live/stream (org-scoped SSE: subscribe to active-set
        |       |     deltas so the dashboard updates without polling)
        |       |
        |       └── POST /live/:runId/abort (on SIGINT/SIGTERM)
        |             • emits run.aborted into the bus
        |             • transitionPendingTestsAfterAbort flips any in-flight
        |               pending test rows to 'skipped' so the UI doesn't show
        |               them as "in progress" forever
        |
Test run completes
        |
Reporter generates output (mochawesome / JUnit / Playwright / Jest / WebdriverIO)
        |
CLI or direct reporter uploads results + screenshots/videos + any snapshots still on disk
        |
POST to backend API (authenticated via API key)
        |
Normalizer converts format -> unified schema
        |
Store in PostgreSQL (merged if same ci_run_id exists)
        |
Dispatch (fire-and-forget, parallel):
  - Webhooks (Slack / Teams / Discord / generic)
  - PR comments + commit status checks (GitHub / GitLab / Bitbucket)
  - Jira auto-create (if enabled) — deduped per fingerprint
  - PagerDuty trigger (if enabled) — deduped per suite+branch
  - Coverage gating commit-status (if threshold configured)
  - Flaky detection
        |
Frontend reads from API (authenticated via JWT) -> displays results
        |
AI analysis available on-demand (failure classification, flaky analysis)
        |
Scheduler (internal, advisory-lock coordinated):
  - Retention cleanup (daily)
  - Scheduled reports (every 30min, sends daily/weekly digests)
```

## Component breakdown

### 1. CLI uploader (`cli/`)

- Reads report files from configurable output directory
- Auto-detects file format based on reporter flag (`.json` or `.xml`)
- Collects run metadata (branch, commit SHA, CI run ID, suite name)
- Discovers and uploads screenshots (`.png`) and videos (`.mp4`)
- Authenticates via API key (`--api-key` flag or `FLAKEY_API_KEY` env var)
- POSTs to `POST /runs/upload` (multipart) or `POST /runs` (JSON only)

### 2. Backend API (`backend/`)

**Public endpoints:**
- `GET /health` — health check
- `POST /auth/login` — email/password login, returns JWT
- `POST /auth/register` — create account

**Authenticated endpoints (JWT or API key):**

*Runs, tests, errors, stats:*
- `POST /runs` — receive report payload (JSON only path; merges into a live placeholder by `ci_run_id` + `suite_name` + `org_id` when one exists)
- `POST /runs/upload` — multipart upload with screenshots/videos
- `GET /runs` — list runs (filtered by org via RLS); each row carries `environment` so the dashboard can group by it. The `summary` separates `passed` / `failed` / `incomplete` so in-progress runs never inflate the pass count
- `GET /runs/:id` — single run with full spec/test tree
- `GET /runs/environments` — distinct environment values present on the org's runs (powers the runs-grid filter dropdown)
- `GET /runs/check` — **mid-run** early-cancel gate: `?ci_run_id=X&suite=&threshold=N` → `{ should_cancel, failed, ... }`. Reads live failures from the `tests` table so it isn't fooled by the lagging `runs.failed` aggregate
- `GET /runs/status` — **post-run** consolidated JSON ship signal: `?ci_run_id=X` or `?suite=name` → `{ status, run_id, ... }` where `status` is `"passed" | "failed" | "incomplete" | "aborted"`. A CI gate polls this instead of composing `failed` + `aborted` + `finished_at` itself or parsing the SVG badge — both derive from the same classifier (`backend/src/run-status.ts`), so they always agree. A missing run is a 404 (fails closed)
- `GET /errors` — failures grouped by error message, filterable by suite/run
- `PATCH /errors/:fingerprint/status` — set status on an error group (open/investigating/known/fixed)
- `GET /errors/:fingerprint/tests` — list affected tests for an error group
- `GET /stats` — dashboard aggregate stats with date range filtering
- `GET /stats/trends` — time-series data (pass rate, failures, duration, top failures)
- `GET /tests/:id` — single test detail with prev/next failure navigation
- `GET /tests/:id/history` — pass/fail timeline for one test across recent runs
- `GET /tests/slowest` — slowest tests with P50/P95/P99 percentiles, trend direction, and duration timeline
- `GET /tests/search/list?q=` — type-ahead search for tests
- `GET /flaky` — list tests classified as flaky (alternating pass/fail across recent runs). Query: `?suite=&runs=&limit=` — `runs` is the recent-run window (default 30, max 500), `limit` caps output rows (default 50, max 200). The JSON body is a plain array; window/cap math is surfaced in response headers (`X-Flaky-Runs-Analyzed`, `X-Flaky-Run-Window-Truncated`, `X-Flaky-Results-Truncated`) so a CI/integrator caller can tell when the classification ran over a truncated window.
- `GET/POST/DELETE /quarantine` — manage the quarantine list of known-flaky tests
- `GET /quarantine/check` — check whether a test is currently quarantined

> **Quarantine is reporter-side only.** Quarantining a test is *advisory*: it
> has **no** effect on `runs.failed`, the `/runs` pass/fail summary, the badge,
> or `/runs/check`. A quarantined test that still fails in CI counts as a
> failure everywhere in the dashboard. The only enforcement path is a reporter
> that calls `GET /quarantine/check` before running and skips the listed tests
> itself. "Isolate flaky tests so they don't block CI" therefore requires
> reporter cooperation — the server does not exclude quarantined tests from any
> gate signal.
- `GET /compare` — diff two runs (added/removed/changed status, duration delta)
- `GET /compare/suites` — list suites available for comparison
- `GET /audit` — read the audit log (org-scoped)
- `GET /badge/:orgSlug/:suiteName.svg` — **public** shields.io-style SVG badge (no auth — see `backend/src/index.ts` mount comment)

*Suite, view, and notes management:*
- `GET /suites` — list suites in the org (rerun-template, archived flag, last-seen-at)
- `PATCH /suites/:name/rename` / `PATCH /suites/:name/archive` / `PATCH /suites/:name/rerun-template` / `DELETE /suites/:name` — suite mutations
- `GET/POST/DELETE /views` — saved-filter dashboards (Phase 6)
- `GET /notes` / `GET /notes/counts` / `POST /notes` — error-group notes (per-fingerprint)

*Webhooks + connectivity probes:*
- `GET/POST/PATCH/DELETE /webhooks` — webhook CRUD (URL schemes restricted to http(s); SSRF gate blocks loopback / private ranges unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`)
- `POST /webhooks/:id/test` — fire a test event against the webhook target
- `POST /connectivity/database` / `/connectivity/email` / `/connectivity/git` — admin/owner-only smoke checks (gated by per-route role check; not RLS — these probe org-level config, not tenant data)

*AI / prediction (Phase 8):*
- `GET /analyze/status` — whether AI features are enabled for the org
- `POST /analyze/test-connection` — verify AI provider creds
- `POST /analyze/error/:fingerprint` / `POST /analyze/flaky` / `POST /analyze/similar/:fingerprint` — error-group analysis, flakiness explanation, similar-failure search
- `POST /predict/tests` — predict which tests should run given a changed-file list
- `GET /predict/split` — parallelisation plan for the next run

*Auth & orgs:*
- `GET /auth/me` — current user info + org list
- `POST /auth/switch-org` — switch active organization
- `GET/POST/DELETE /auth/api-keys` — manage API keys
- `POST /auth/refresh` / `POST /auth/logout` — refresh-token rotation + revocation (consumes the prior `jti` via the `revoked_refresh_tokens` table)
- `GET/POST /orgs` — list/create organizations
- `GET /orgs/:id/members` — list org members
- `PATCH /orgs/:id/members/:userId` — change a member's role (admin/owner only)
- `POST /orgs/:id/invites` — invite user by email
- `POST /orgs/invites/:token/accept` — accept invite
- `DELETE /orgs/:id/members/:userId` — remove member
- `GET/PATCH /orgs/:id/settings` — read/update org-level settings (Jira / PagerDuty / git integration creds, all encrypted at rest)

*Quality metrics (Phase 10):*
- `POST /coverage` — upload Istanbul-style coverage summary for a run; optional `release` field upserts the release and links the run via `release_runs`
- `GET /coverage/runs/:runId` — retrieve coverage for a run
- `GET /coverage/trend` — coverage trend across recent runs
- `GET/PATCH /coverage/settings` — PR coverage-gating threshold and enable flag
- `POST /a11y` — upload axe-core results for a run (auto-scored from impact counts)
- `GET /a11y/runs/:runId` — a11y reports for a run
- `GET /a11y/trend` — a11y score trend across recent runs
- `POST /visual` — upload a batch of visual-diff records for a run
- `GET /visual/runs/:runId` — visual diffs for a run
- `GET /visual/pending` — cross-run queue of pending/changed/new diffs
- `PATCH /visual/:id` — approve/reject/update a visual diff's status
- `POST /security` — upload normalized security findings + the raw scanner payload (ZAP, Trivy, …); upserts one row per `(run_id, scanner)` and replaces previous findings on re-upload
- `GET /security/runs/:runId` — scans + findings for a run, severity-sorted
- `GET /security/trend` — recent scans across the org for trend rendering
- `POST /ui-coverage/visits` — record visited routes from a test run
- `GET /ui-coverage` — list visited routes
- `GET /ui-coverage/untested` — known routes without any visits
- `GET /ui-coverage/summary` — overall coverage % vs the known-routes inventory
- `POST/DELETE /ui-coverage/routes` — manage the known-routes inventory

*Manual tests & releases (Phase 10):*
- `GET/POST/PATCH/DELETE /manual-tests` — manage manual tests. GET responses join against the latest matching automated test so imported Cucumber scenarios surface their real automation status. PATCH is rejected with `409` for `source='cucumber'` rows (edit the `.feature` file and re-import instead)
- `POST /manual-tests/import-features` — bulk import `.feature` files as manual tests. Body: `{ files: [{path, content}] }`. Upserts by `(org_id, 'cucumber', source_ref)` where `source_ref = <path>::<scenario name>`, so re-imports are idempotent. Scenario Outlines are expanded per `Examples:` row
- `POST /manual-tests/:id/result` — record an execution outcome (manual source only)
- `GET /manual-tests/summary` — status breakdown counts
- `GET/POST/PATCH/DELETE /releases` — manage releases
- `POST /releases/:id/sign-off` — sign off a release (refuses unless all required checklist items are checked)
- `POST/PATCH/DELETE /releases/:id/items` — manage release checklist items
- `GET/POST/PATCH /releases/:id/sessions` — release test sessions (full / failures-only re-runs); rows seeded at create time so progress counting is trivial
- `POST /releases/:id/sessions/:sessionId/results/:testId` — record a per-test status + notes within a session
- `POST /releases/:id/sessions/:sessionId/results/:testId/accept` — defer a failure as a known issue. Body: `{ known_issue_ref?: string }` — accepts a plain key (`JIRA-123`) or an http(s) URL; non-http(s) URLs are rejected at the boundary
- `POST /releases/:id/sessions/:sessionId/results/:testId/file-bug` — create the bug in the configured tracker (Jira) and persist `filed_bug_key` / `filed_bug_url` on the result
- `POST/DELETE /releases/:id/sessions/:sessionId/results/:testId/evidence` — multipart attachment upload (20 MB cap per file, max 20 files; SVG/SVGZ rejected to stop a stored XSS via the attachment link). `url` is re-derived from `key` at GET time (presigns expire after 1h)
- `GET /releases/:id/requirements` — coverage rollup by requirement; groups linked manual tests per requirement with pass/fail counts from the latest session
- `GET/POST/DELETE /manual-tests/:id/requirements` — link a manual test to story refs (Jira/GitHub/Linear). `ref_url` must be http(s); other schemes are rejected on write
- `GET/POST/PATCH/DELETE /manual-test-groups` — organize manual tests into named groups for batched session runs

*Integrations (Phase 9):*
- `GET/PATCH /jira/settings` — configure Jira connection (token encrypted at rest)
- `POST /jira/test` — validate Jira credentials via `/rest/api/2/myself`
- `POST /jira/issues` — manually create an issue from a failure (deduped by fingerprint)
- `GET /jira/issues` — list tracked issues
- `GET/PATCH /pagerduty/settings` — configure PagerDuty (integration key encrypted at rest)
- `POST /pagerduty/test` — fire a test event
- `GET/POST/PATCH/DELETE /reports` — scheduled reports CRUD
- `POST /reports/:id/run` — trigger a one-off dispatch (for testing)

### 3. Normalizer (`backend/src/normalizers/`)

Each reporter has its own parser that converts to a unified internal schema. All parsers produce the same `NormalizedRun` structure. See [backend/docs/normalizer.md](../backend/docs/normalizer.md) for full details.

Supported reporters:
- **Mochawesome** — Cypress/Mocha JSON output
- **JUnit** — XML format (Jest, pytest, Go, Java, .NET, PHPUnit)
- **Playwright** — Playwright JSON reporter output
- **Jest** — Jest JSON output
- **WebdriverIO** — WebdriverIO JSON output

### 4. Authentication & Multi-tenancy

**Auth flow:**
- Users log in with email/password -> receive a short-lived access token (1h) and a refresh token (7d)
- JWT contains user ID, email, name, role, and `orgId` (active organization)
- API keys (`fk_` prefix) for CLI/programmatic access, scoped to an organization
- API keys are stored as bcrypt hashes with an 8-char prefix for index lookup; verification runs server-side in a Postgres `SECURITY DEFINER` function (`verify_api_key`, migration 041) which compares via pgcrypto and returns ONLY the matched row's identity columns — the bcrypt hash is never returned to the application layer, closing the prior hash-enumeration path
- Per-account lockout: 5 wrong-password attempts (env-tunable via `LOGIN_LOCKOUT_THRESHOLD`) locks the account for 15 minutes (`LOGIN_LOCKOUT_MINUTES`) on top of the per-IP rate limit, defending the single-account threat that a distributed brute-force from many IPs would otherwise fly under
- Login response time is bcrypt-bounded even on unknown emails (a dummy compare runs on the unknown-email branch) so account existence can't be enumerated by timing
- Refresh tokens carry a `jti` claim; `/auth/logout` and `/auth/refresh` both revoke the consumed jti via the `revoked_refresh_tokens` table, giving real server-side logout + refresh-token rotation
- `requireAuth` re-reads `org_members` on every request, so a removed member's JWT or API key 401s on the next request rather than retaining access until JWT exp

**Tenant isolation:**
- Every run belongs to an organization (`runs.org_id`)
- Postgres Row-Level Security (RLS) enforces isolation at the database level
- RLS policies on `runs`, `specs`, `tests`, and `api_keys` filter by `current_setting('app.current_org_id')`
- The session variable is set per-transaction via `tenantQuery()`/`tenantTransaction()` helpers
- The app connects as a non-superuser role (`flakey_app`) so RLS cannot be bypassed
- Even if application code has a bug, the database blocks cross-tenant data access

**Org management:**
- Users can create organizations and invite members by email
- Invites are token-based with 7-day expiry
- Roles: owner, admin, viewer
- New users without an invite get a personal organization automatically

### 5. PostgreSQL schema

```sql
-- Auth
users (id, email, password_hash, name, role,
       email_verified, email_verification_token, email_verification_expires_at,
       password_reset_token, password_reset_expires_at,
       failed_login_attempts, locked_until,
       created_at)
-- failed_login_attempts + locked_until (migration 036) implement
-- per-account brute-force lockout on top of the per-IP rate limit.
api_keys (id, user_id, key_hash, key_prefix, label, org_id, last_used_at, created_at)
revoked_refresh_tokens (jti, user_id, revoked_at)
-- migration 037 / 040. /auth/logout inserts the current refresh token's
-- jti here; /auth/refresh consults it before issuing a new pair AND
-- inserts the consumed jti on success (refresh-token rotation).
-- FORCE ROW LEVEL SECURITY is enabled (migration 040) keyed on
-- app.current_user_id (not org_id — this is a per-user table). The
-- userScopedQuery helper in backend/src/db.ts sets the session var.

-- Multi-tenancy
organizations (id, name, slug, created_at)
org_members (id, org_id, user_id, role, joined_at)
org_invites (id, org_id, email, role, token, invited_by, accepted_at, expires_at, created_at)

-- Test data (org-scoped via RLS)
runs (id, suite_name, branch, commit_sha, ci_run_id, reporter,
      started_at, finished_at, total, passed, failed, skipped, pending,
      duration_ms, org_id, environment, created_at)
-- environment is the target the suite ran against (e.g. "qa", "stage").
-- Reporters surface it via meta.environment on uploads / on the
-- /live/start payload; the dashboard renders it as a header chip and
-- offers a filter dropdown on the runs grid.

specs (id, run_id, file_path, title, total, passed, failed, skipped, duration_ms)

tests (id, spec_id, title, full_title, status, duration_ms,
       error_message, error_stack, screenshot_paths, video_path,
       snapshot_path, test_code, command_log, metadata)
-- command_log (JSONB): Mochawesome step records (Cypress chained
-- commands, assertions, retries). Rendered in the dashboard's
-- "Commands" timeline below the screenshot.
-- metadata (JSONB): reporter-specific extras — Playwright retries +
-- tags + annotations; JUnit properties; ANSI-coloured error snippets.
-- Free-form; the dashboard renders known shapes and ignores the rest.

-- Quality metrics (Phase 10, org-scoped via RLS)
coverage_reports (id, org_id, run_id, lines_pct, branches_pct, functions_pct,
                  statements_pct, lines_covered, lines_total, files, created_at)

a11y_reports (id, org_id, run_id, url, score, violations_count, violations,
              passes_count, incomplete_count,
              critical_count, serious_count, moderate_count, minor_count, created_at)

visual_diffs (id, org_id, run_id, test_id, name, baseline_path, current_path,
              diff_path, diff_pct, status, reviewed_by, reviewed_at, created_at)

security_scans (id, org_id, run_id, scanner, target,
                high_count, medium_count, low_count, info_count,
                raw_report, created_at)
-- One row per (run_id, scanner). raw_report holds the original scanner JSON.
security_findings (id, scan_id, org_id, run_id, rule_id, name, severity,
                   description, solution, url, cwe, instances, metadata, created_at)
-- severity ∈ {'high','medium','low','info'}. Replaced atomically on re-upload.

ui_coverage      (id, org_id, suite_name, route_pattern, visit_count,
                  first_seen, last_seen, last_run_id)
ui_known_routes  (id, org_id, route_pattern, label, source, created_at)

-- Manual tests + releases (Phase 10, org-scoped via RLS)
manual_tests (id, org_id, suite_name, title, description, steps, expected_result,
              priority, status, last_run_at, last_run_by, last_run_notes,
              automated_test_key, tags, created_by, created_at, updated_at,
              source, source_ref, source_file)
-- source ∈ {'manual','cucumber'}. When 'cucumber', source_ref =
-- '<file>::<scenario name>' is the idempotency key for re-imports and
-- source_file is displayed in the UI "covered by automation" banner.
-- A unique partial index on (org_id, source, source_ref) WHERE source_ref
-- IS NOT NULL enforces upsert semantics for imported rows.

releases (id, org_id, version, name, status, target_date, description,
          signed_off_by, signed_off_at, created_by, created_at, updated_at)
release_checklist_items (id, org_id, release_id, label, required, checked,
                         checked_by, checked_at, position, notes)

-- Integrations (Phase 9)
scheduled_reports (id, org_id, name, cadence, day_of_week, hour_utc, channel,
                   destination, suite_filter, active, last_sent_at, created_at)
failure_jira_issues (id, org_id, fingerprint, issue_key, issue_url,
                     created_by, created_at)

-- New columns on `organizations` for Phase 9 / 10:
--   jira_base_url, jira_email, jira_api_token (encrypted), jira_project_key,
--   jira_issue_type, jira_auto_create
--   pagerduty_integration_key (encrypted), pagerduty_severity, pagerduty_auto_trigger
--   coverage_threshold, coverage_gate_enabled
```

### 6. Integrations (`backend/src/integrations/`)

Fire-and-forget helpers invoked from the upload flow. Each reads its own
configuration from the `organizations` table and silently no-ops if not
configured, so enabling one integration never affects the others.

- **`jira.ts`** — creates Jira issues via `/rest/api/2/issue`, deduped per
  test fingerprint in the `failure_jira_issues` table. Reads the token via
  `decryptSecret()`. The same module exposes `createIssueForFingerprint()`
  used by the `/jira/issues` manual-create endpoint.
- **`pagerduty.ts`** — fires Events API v2 triggers with a stable dedup key
  (`flakey-<orgId>-<suite>-<branch>`) so a persistently failing suite does
  not spam on-call.
- **`coverage-gate.ts`** — when a coverage upload comes in and gating is
  enabled, posts a commit status via whichever git provider the org has
  configured, using the same provider abstraction as PR comments.

### 7. Scheduled reports dispatcher (`backend/src/scheduled-reports.ts`)

A periodic tick that selects due reports, renders a daily or weekly test
summary, and delivers it via email, Slack, or a generic webhook. The
dispatcher takes a Postgres session-scoped advisory lock
(`pg_try_advisory_lock(0x666c616b79)`) before running, so multi-replica
backends do not double-fire.

### 8. Secrets encryption (`backend/src/crypto.ts`)

AES-256-GCM envelope encryption for secrets stored on the `organizations`
table (`jira_api_token`, `pagerduty_integration_key`). Ciphertext format:
`v1:<base64 iv>:<base64 authTag>:<base64 ct>`. The key comes from the
`FLAKEY_ENCRYPTION_KEY` env var (32 bytes as base64 or hex). If unset,
`encryptSecret()` is a no-op and `decryptSecret()` passes plaintext
through — so local development works without configuration, and rolling
out the key is a non-breaking change (existing plaintext values continue
to decrypt cleanly thanks to the `v1:` prefix check).

### 9. Frontend (`frontend/`)

SvelteKit app with Svelte 5, organized in route groups:

- **`/login`** — login/register page (no sidebar, public)
- **`/(app)/`** — authenticated shell with sidebar navigation
  - **Dashboard** — metrics cards, trend charts (pass rate, test volume, duration, top failures), date range picker, recent runs/failures
  - **Runs** — list view with suite filtering
  - **Run detail** (`/runs/:id`) — progress ring, status filter tabs, test search, collapsible spec sections, error modal with screenshots/video/commands/source; tabbed `RunExtras` panel for coverage, accessibility, and visual-diff review inline on the same page
  - **Flaky** — tests that alternate between pass/fail across runs
  - **Errors** — failures grouped by error message with suite/run filtering
  - **Manual tests** — CRUD for manual regression tests with status, steps, expected results, and result recording
  - **Releases** — release cards with checklist progress bars; release detail view with checklist toggle, add/remove items, and sign-off button (disabled until required items checked)
  - **Settings** — project configuration + link to `/settings/integrations`
  - **Settings / Integrations** — consolidated admin page for Jira, PagerDuty, coverage gating, and scheduled reports (with test-connection buttons)
  - **Settings** — account info, API key management (create/list/delete)

## CI integration examples

### GitHub Actions

```yaml
- name: Upload test results
  if: always()
  run: npx flakey-upload --suite my-e2e --reporter mochawesome
  env:
    FLAKEY_API_URL: ${{ secrets.FLAKEY_API_URL }}
    FLAKEY_API_KEY: ${{ secrets.FLAKEY_API_KEY }}
    BRANCH: ${{ github.ref_name }}
    COMMIT_SHA: ${{ github.sha }}
    CI_RUN_ID: ${{ github.run_id }}
```

### Bitbucket Pipelines

```yaml
- step:
    name: Upload test results
    after-script:
      - npx flakey-upload --suite my-e2e --reporter junit --report-dir test-results
```
