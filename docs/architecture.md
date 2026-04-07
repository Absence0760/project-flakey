# Architecture

## Stack

| Layer | Technology |
|---|---|
| Test runner | Cypress, Playwright, Jest, or any framework |
| Reporters | Mochawesome (JSON), JUnit (XML), Playwright (JSON) |
| Upload CLI | `@flakey/cli` (npm package) |
| Snapshot plugin | `@flakey/cypress-snapshots` (npm package) |
| Backend API | Node.js + Express |
| Normalizer | Per-reporter parser -> unified schema |
| Database | PostgreSQL 16 with Row-Level Security |
| Auth | JWT + API keys, bcrypt, httpOnly cookies, refresh tokens |
| Multi-tenancy | Organization-based isolation via Postgres RLS |
| Frontend | SvelteKit (Svelte 5), static-hosted on S3/CloudFront |
| Infrastructure | Terraform (AWS: ECS Fargate, RDS, S3, CloudFront) |
| CI/CD | GitHub Actions (deploy + npm publish) |

## System flow

```
Test run completes
        |
Reporter generates output (mochawesome JSON / JUnit XML / Playwright JSON)
        |
CLI reads output files + screenshots/videos + metadata
        |
POST to backend API (authenticated via API key)
        |
Normalizer converts format -> unified schema
        |
Store in PostgreSQL (scoped to organization via org_id)
        |
Frontend reads from API (authenticated via JWT) -> displays results
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
- `POST /runs` — receive report payload
- `POST /runs/upload` — multipart upload with screenshots/videos
- `GET /runs` — list runs (filtered by org via RLS)
- `GET /runs/:id` — single run with full spec/test tree
- `GET /errors` — failures grouped by error message, filterable by suite/run
- `GET /stats` — dashboard aggregate stats with date range filtering
- `GET /stats/trends` — time-series data (pass rate, failures, duration, top failures)
- `GET /tests/:id` — single test detail with prev/next failure navigation
- `GET /auth/me` — current user info + org list
- `POST /auth/switch-org` — switch active organization
- `GET/POST/DELETE /auth/api-keys` — manage API keys
- `GET/POST /orgs` — list/create organizations
- `GET /orgs/:id/members` — list org members
- `POST /orgs/:id/invites` — invite user by email
- `POST /orgs/invites/:token/accept` — accept invite
- `DELETE /orgs/:id/members/:userId` — remove member

### 3. Normalizer (`backend/src/normalizers/`)

Each reporter has its own parser that converts to a unified internal schema. All parsers produce the same `NormalizedRun` structure. See `normalizer.md` for full details.

Supported reporters:
- **Mochawesome** — Cypress/Mocha JSON output
- **JUnit** — XML format (Jest, pytest, Go, Java, .NET, PHPUnit)
- **Playwright** — Playwright JSON reporter output

### 4. Authentication & Multi-tenancy

**Auth flow:**
- Users log in with email/password -> receive a JWT (7-day expiry)
- JWT contains user ID, email, name, role, and `orgId` (active organization)
- API keys (`fk_` prefix) for CLI/programmatic access, scoped to an organization
- API keys are stored as bcrypt hashes with a prefix for efficient lookup

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
- Roles: owner, admin, member
- New users without an invite get a personal organization automatically

### 5. PostgreSQL schema

```sql
-- Auth
users (id, email, password_hash, name, role, created_at)
api_keys (id, user_id, key_hash, key_prefix, label, org_id, last_used_at, created_at)

-- Multi-tenancy
organizations (id, name, slug, created_at)
org_members (id, org_id, user_id, role, joined_at)
org_invites (id, org_id, email, role, token, invited_by, accepted_at, expires_at, created_at)

-- Test data (org-scoped via RLS)
runs (id, suite_name, branch, commit_sha, ci_run_id, reporter,
      started_at, finished_at, total, passed, failed, skipped, pending,
      duration_ms, org_id, created_at)

specs (id, run_id, file_path, title, total, passed, failed, skipped, duration_ms)

tests (id, spec_id, title, full_title, status, duration_ms,
       error_message, error_stack, screenshot_paths, video_path,
       test_code, command_log)
```

### 6. Frontend (`frontend/`)

SvelteKit app with Svelte 5, organized in route groups:

- **`/login`** — login/register page (no sidebar, public)
- **`/(app)/`** — authenticated shell with sidebar navigation
  - **Dashboard** — metrics cards, trend charts (pass rate, test volume, duration, top failures), date range picker, recent runs/failures
  - **Runs** — list view with suite filtering
  - **Run detail** (`/runs/:id`) — progress ring, status filter tabs, test search, collapsible spec sections, error modal with screenshots/video/commands/source
  - **Flaky** — tests that alternate between pass/fail across runs
  - **Errors** — failures grouped by error message with suite/run filtering
  - **Settings** — project configuration (placeholder)
  - **Profile** — account info, API key management (create/list/delete)

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
