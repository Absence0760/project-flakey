# Flakey

A self-hosted, CI-agnostic test reporting dashboard. Collects test results from Cypress, Playwright, Jest, pytest, and any framework that outputs Mochawesome JSON, JUnit XML, or Playwright JSON. Displays results with trend charts, flaky test detection, and failure analysis.

Multi-tenant with organization-based isolation via Postgres Row-Level Security. JWT + API key authentication.

## Quick Start

### Prerequisites

- [Docker](https://www.docker.com/) (for PostgreSQL + Mailpit)
- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) (for the frontend)

### 1. Start the local services

```bash
docker compose up -d
```

Starts PostgreSQL and Mailpit (a local SMTP sink — view sent mail at http://localhost:8025). Artifact storage, AI, and integrations are local-first or optional, so nothing else is required. To exercise the S3 or outbound-webhook code paths locally, opt into the bundled MinIO / webhook sink — see [docs/run-locally.md](docs/run-locally.md#1-start-the-local-services).

### 2. Install dependencies

```bash
pnpm install              # frontend + packages (pnpm workspace)
pnpm install:backend      # backend (uses its own npm lockfile)
```

### 3. Seed sample data

```bash
cd backend && npm run seed
```

Creates three users (admin / demo / viewer), two orgs, and ~85 sample test runs across ~25 suites spanning Mochawesome, Playwright, and JUnit.

### 4. Start the app

```bash
pnpm dev
```

- **Frontend:** http://localhost:7778
- **API:** http://localhost:3000

### 5. Log in

- **Email:** `admin@example.com`
- **Password:** `admin`

## Upload Test Results

### Cypress (recommended)

```bash
npm install --save-dev @flakeytesting/cypress-reporter @flakeytesting/cypress-snapshots
```

```typescript
// cypress.config.ts
import { setupFlakey } from "@flakeytesting/cypress-reporter/plugin";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  },
  e2e: {
    async setupNodeEvents(on, config) {
      // setupFlakey wires up the reporter + snapshots + live-reporter
      // in one call. Use `flakeyReporter` directly only if you want to
      // opt out of snapshots / live streaming.
      await setupFlakey(on, config);
      return config;
    },
  },
});
```

```typescript
// cypress/support/e2e.ts
import "@flakeytesting/cypress-reporter/support";
import "@flakeytesting/cypress-snapshots/support";
```

Screenshots stream to the backend the moment Cypress finishes writing each one (via `after:screenshot`), so a failing test's image shows up on the run detail page within hundreds of milliseconds — no need to wait for the run to finish. **On a successful upload the local file is deleted** (mirroring how Cypress Cloud handles per-spec artifacts), so a long suite full of failures can't fill a CI runner's disk while waiting for `after:run`. Videos still upload at end-of-run, and any screenshots that didn't stream (no live run id, network blip, etc.) get shipped by the end-of-run batch as a fallback. DOM snapshots stream the same way (via `POST /live/:runId/snapshot`) when the live reporter (`@flakeytesting/live-reporter`) is active. For Cucumber projects, also add `import "@flakeytesting/cypress-snapshots/cucumber"` to your support file to capture Gherkin step markers in each snapshot bundle.

To label which environment a run executed against (so the dashboard can show it as a chip and offer it as a filter), set `FLAKEY_ENV=qa` (or `TEST_ENV=qa`) in the test command, or use Cypress's own `--env environment=qa` / `--env name=qa` — the reporter resolves any of those automatically.

Concurrent `cypress run` invocations on the same machine are supported out of the box — the reporter walks each process's ancestor chain to find the nearest shared ancestor with the plugin, so the two process trees stay isolated without needing a custom `TMPDIR`.

#### Using `cypress-multi-reporters`

If you wrap the Mocha reporter with [`cypress-multi-reporters`](https://www.npmjs.com/package/cypress-multi-reporters) (e.g. to run `mochawesome` alongside Flakey), `config.reporterOptions` is reshaped by the wrapper, so pass Flakey's options explicitly as the third arg:

```typescript
import { defineConfig } from "cypress";
import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin";
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

const flakeyOptions = {
  url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
  apiKey: process.env.FLAKEY_API_KEY!,
  suite: "my-project",
};

export default defineConfig({
  reporter: "cypress-multi-reporters",
  reporterOptions: {
    reporterEnabled: "mochawesome, @flakeytesting/cypress-reporter",
    mochawesomeReporterOptions: { reportDir: "cypress/reports/mochawesome", json: true },
    flakeytestingCypressReporterReporterOptions: flakeyOptions,
  },
  e2e: {
    setupNodeEvents(on, config) {
      flakeyReporter(on, config, flakeyOptions);           // <-- pass flakeyOptions explicitly
      flakeySnapshots(on, config);
      return config;
    },
  },
});
```

### Playwright

```bash
npm install --save-dev @flakeytesting/playwright-reporter
```

```typescript
// playwright.config.ts
reporter: [
  ["@flakeytesting/playwright-reporter", {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  }],
],
```

### WebdriverIO

```bash
npm install --save-dev @flakeytesting/webdriverio-reporter
```

```typescript
// wdio.conf.ts
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

export const config = {
  reporters: [[FlakeyReporter, {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  }]],
};
```

### CLI (alternative for any framework)

```bash
npx tsx packages/flakey-cli/src/index.ts \
  --report-dir cypress/reports \
  --suite my-project \
  --reporter mochawesome \
  --api-key $FLAKEY_API_KEY
```

Also supports `--reporter playwright`, `--reporter junit`, `--reporter jest`, and `--reporter webdriverio`.

The CLI also ships uploaders for quality metrics beyond pass/fail:

```bash
# Code coverage (Istanbul coverage-summary.json)
npx flakey-upload coverage --run-id 42 --file coverage/coverage-summary.json

# Accessibility (axe-core results)
npx flakey-upload a11y --run-id 42 --file axe-results.json --url /

# Visual regression diffs
npx flakey-upload visual --run-id 42 --file visual-manifest.json

# UI coverage — record which routes tests visited
npx flakey-upload ui-coverage --suite my-e2e --file visits.json --run-id 42
```

See [packages/flakey-cli/docs/uploading-results.md](packages/flakey-cli/docs/uploading-results.md#uploading-quality-metrics) for the expected file formats.

### Postman (Newman)

```bash
newman run collection.json --reporters junit --reporter-junit-export results.xml
npx flakey-upload upload --report-dir . --suite api-tests --reporter junit
```

### OWASP ZAP

ZAP results can be converted to JUnit XML and uploaded. See `examples/zap/` for a working converter script.

### curl

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"meta\":{\"suite_name\":\"my-project\",\"branch\":\"main\",\"commit_sha\":\"\",\"ci_run_id\":\"\",\"started_at\":\"\",\"finished_at\":\"\",\"reporter\":\"mochawesome\"},\"raw\":$(cat cypress/reports/mochawesome.json)}"
```

Create an API key from the Settings page for permanent access (no expiry).

## Features

### Dashboard
- Metrics cards (total runs, tests, pass rate, failures)
- Trend charts (pass rate, test volume, run duration, top failures)
- Date range picker with presets and calendar
- Dark/light/system theme toggle

### Runs List
- **Multi-filter** — suite, branch, status (passed/failed/new failures), date range, and search
- **Spec file preview** — each run card shows the spec files that were run
- **New failures badge** — highlights runs with regressions vs known failures
- **Pinned runs** — pin runs for quick access during debugging
- **Compare mode** — select two runs from the filtered list and compare
- **Pagination** — load more on demand with accurate total counts
- **URL persistence** — all filters sync to URL for bookmarkable/shareable views

### Test Analysis
- **Run detail** — progress ring, status filters, test search, collapsible specs, prev/next run navigation
- **Smart defaults** — auto-filters to failed tests, auto-expands failed specs, sticky filter toolbar
- **Copy buttons** — suite name, feature name, scenario name, error messages
- **Rerun commands** — per-suite configurable template (`{spec}`, `{specs}`, `{title}`); copy single or all failed rerun commands
- **Copy for tickets** — formatted run summary for Jira (wiki markup) or Markdown with status icons
- **Error modal** — screenshots with zoomable lightbox, video player, command log, source code, stack trace, resizable split panes
- **Flaky tests** — server-side detection with flakiness rate, flip count, visual pass/fail timeline, suite filter, and sortable rankings
- **Auto-quarantine** — opt-in policy (enable + min flips / min runs) that fences off a known-flaky test at run finalization so it stops blocking PR merges, while the dashboard and badge keep reporting its honest failure state. Never overwrites a manual quarantine.
- **AI failure analysis** — per-error and per-test root-cause classification, summary, and suggested fix (cached per fingerprint)
- **AI root-cause clustering** — groups the org's distinct failures into clusters by similarity, with an AI-generated theme label per multi-error cluster
- **Slowest tests** — ranked by duration with P50/P95/P99 percentiles, trend analysis (getting slower/faster), mini sparkline, and expandable duration history chart
- **Error tracking** — failures grouped by error message with status (open/investigating/known/fixed/ignored), an assignable owner (the pre-Jira "who's chasing this?" triage moment), first/last seen, affected run count, and team notes thread; failures also roll up per release so they can be handed out during a release
- **Test history** — pass/fail timeline for a single test across runs
- **Compare runs** — side-by-side diff showing regressions, fixes, and unchanged tests

### Reporter Metadata
- **Playwright:** test title path, status, duration, error message + stack, screenshot and video attachment paths, and (when traces are present) command logs via `@flakeytesting/playwright-snapshots`
- **JUnit:** exception types, classnames, properties, hostname, skip reasons, stdout/stderr
- **Mochawesome:** command logs, test source code

### Auth & Multi-tenancy
- JWT authentication (1hr access + 7d refresh tokens)
- API keys for CI/programmatic access
- Organization-based tenant isolation via Postgres Row-Level Security
- Roles: Owner, Admin, Viewer
- Invite-by-email flow
- Rate limiting, httpOnly cookies, CORS whitelist, security headers

### Quality Metrics
- **Code coverage tracking** — upload Istanbul-style `coverage-summary.json` per run; color-coded bars for lines/branches/functions/statements on the run detail page
- **PR coverage gating** — configurable minimum threshold posts a pass/fail commit status on the PR (reuses the same git provider credentials as PR comments)
- **Accessibility reports** — upload axe-core results; auto-scored by impact (critical/serious/moderate/minor) with expandable violations list
- **Visual regression** — store baseline/current/diff image paths; approve or reject changed screenshots inline from the run detail page
- **UI coverage mapping** — track which routes tests visit and compare against a known-routes inventory to surface untested pages

### Manual & Release Management
- **Manual test management** — unified platform for manual regression tests alongside automated ones: steps, expected results, priority, status, execution history, optional linkage to automated test keys
- **Release checklists with sign-off** — create releases with default checklists (critical tests passing, regression suite, release notes, docs, stakeholder notification, rollback plan); enforces "all required items complete" before sign-off

### Integrations
- **PR/MR comments** — auto-posts test summary (pass rate, failures, flaky tests, trend) as a PR/MR comment on GitHub, GitLab, or Bitbucket; updates existing comment on re-runs
- **Jira integration** — auto-create deduped issues for new failures or open tickets manually from the error view
- **PagerDuty integration** — fire Events API v2 incidents on run failure with configurable severity and per-suite dedup keys
- **Scheduled reports** — daily/weekly test digests delivered via email, Slack, or webhook; filterable by suite; advisory-lock coordinated so multi-replica backends don't double-fire
- **Webhook notifications** — rich formatted messages for Slack (Block Kit), Teams (Adaptive Cards), Discord (Embeds), or generic JSON; events include run results, new failures, flaky detection, and a configurable per-org **flaky-rate threshold** alert (`flaky.threshold.exceeded`)
- **AI draft fix PRs** — open a *draft* pull/merge request with an AI-proposed fix for a failing test on GitHub, GitLab, or Bitbucket. Always a draft for human review — never auto-merged — with file-size and truncation guards and per-target idempotency. Needs a git token with write/PR scope (see [backend/docs/integrations.md](backend/docs/integrations.md))
- **Status badges** — embeddable SVG badge for READMEs: `![tests](https://your-flakey-instance.com/badge/my-suite)`
- **Secrets encryption at rest** — Jira tokens and PagerDuty keys are AES-256-GCM encrypted (via `FLAKEY_ENCRYPTION_KEY`); gracefully falls back to plaintext in local dev

### Air-gapped AI
All AI-assisted features — failure root-cause analysis, flaky-test analysis, root-cause clustering, and the draft fix PRs — run against the instance-configured AI provider. Point that provider at a **local model and no data leaves the box**: set `AI_PROVIDER=openai` and `AI_BASE_URL=http://localhost:11434/v1` to drive a local Ollama (`pnpm ai:up`). Prompts (error messages, stack traces, source files) go only to your own model — there is no outbound call to a hosted LLM, which keeps AI features usable in regulated / air-gapped deployments. AI is instance-wide and off by default; leave it unconfigured and the generation routes return 503 while everything else works unchanged. See [backend/docs/integrations.md](backend/docs/integrations.md#air-gapped-ai).

### Admin
- Team management (invite, roles, remove)
- Suite management (rename, archive, delete, rerun command templates)
- Data retention (auto-delete runs older than N days, default 7 days)
- Audit log
- Integrations & automation page (Jira, PagerDuty, coverage gating, scheduled reports) with test-connection buttons
- Toast notifications for all settings mutations (success/error feedback)

## Architecture

```
Test run → Reporter output → CLI upload → Normalizer → PostgreSQL (RLS) → Svelte dashboard
```

| Layer | Technology |
|---|---|
| Frontend | SvelteKit (Svelte 5) |
| Backend | Express + Node.js |
| Database | PostgreSQL 16 with Row-Level Security |
| Auth | JWT + bcrypt + API keys |
| Reporters | Mochawesome, JUnit XML, Playwright JSON, Jest JSON, WebdriverIO JSON |

## CI Integration

### GitHub Actions

```yaml
- name: Upload results
  if: always()
  run: npx tsx packages/flakey-cli/src/index.ts --report-dir cypress/reports --suite my-project
  env:
    FLAKEY_API_URL: ${{ secrets.FLAKEY_API_URL }}
    FLAKEY_API_KEY: ${{ secrets.FLAKEY_API_KEY }}
    BRANCH: ${{ github.ref_name }}
    COMMIT_SHA: ${{ github.sha }}
    CI_RUN_ID: ${{ github.run_id }}
```

### Bitbucket Pipelines

```yaml
after-script:
  - npx tsx packages/flakey-cli/src/index.ts --report-dir cypress/reports --suite my-project
```

## Environment Variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | _(required in production)_ | JWT signing secret |
| `FLAKEY_BOOTSTRAP_ADMIN_EMAIL` / `FLAKEY_BOOTSTRAP_ADMIN_PASSWORD` | — | Set **both** to idempotently create the first admin on boot (role `admin` + personal org + `owner` membership). No-ops if either is unset; never resets an existing user's password, so it's safe to leave set across restarts. The supported way to seed the first user in production (no default credentials ship). |
| `DB_USER` | `flakey_app` | Database user (non-superuser for RLS) |
| `DB_PASSWORD` | `flakey_app` | Database password |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `localhost` / `5432` / `flakey` | Postgres connection target |
| `PORT` | `3000` | API port |
| `CORS_ORIGINS` | `http://localhost:7778,http://localhost:3000` | Allowed origins (comma-separated). Dev default includes both the frontend (7778) and the backend itself (3000) so health probes from the same machine pass. |
| `FRONTEND_URL` | `http://localhost:7778` | Frontend URL (used in webhook notification links) |
| `ALLOW_REGISTRATION` | `false` | Set `true` to allow open self-service registration (each new user gets their own tenant/org as owner). When `false` (default), `POST /auth/register` returns 403 unless the request carries a valid `invite_token`. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | When `true`, registered users must verify their email (via the `SMTP_*` chain) before logging in. |
| `STORAGE` | `local` | `local` writes uploads to `uploads/runs/{id}/...` on disk; `s3` puts them in `S3_BUCKET` and serves via signed URLs / CloudFront. |
| `S3_BUCKET` / `S3_REGION` | — / `us-east-1` | S3 bucket name and region (only when `STORAGE=s3`). |
| `S3_ENDPOINT` | — | Custom endpoint for an S3-compatible store (MinIO, Ceph, Backblaze). Set to `http://localhost:9000` to use the bundled MinIO (`docker compose --profile storage up -d`). Unset = real AWS S3. |
| `S3_FORCE_PATH_STYLE` | `true` when `S3_ENDPOINT` is set | Path-style bucket addressing — required for MinIO. Set `false` to opt back out. Credentials come from the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` chain (`minioadmin` / `minioadmin` for local MinIO). |
| `S3_PREFIX` | `""` | Optional key prefix prepended to every artifact key (only when `STORAGE=s3`) — e.g. to share a bucket across environments. |
| `CDN_URL` | — | When set, artifact URLs are served from this base (e.g. a CloudFront distribution) instead of S3 signed URLs. |
| `NODE_ENV` | — | Set `production` to refuse boot without JWT_SECRET and FLAKEY_ENCRYPTION_KEY. CORS_ORIGINS still applies the same allow-list in any env — there's no looser dev-only fallback. |
| `FLAKEY_ENCRYPTION_KEY` | _(required in production)_ | 32-byte key (base64 or hex) for AES-256-GCM encryption of Jira/PagerDuty secrets. Validated at boot — a malformed value refuses to start, not just an unset one. Unset = plaintext passthrough (local dev only — backend refuses to start in production). |
| `FLAKEY_ENCRYPTION_KEY_OLD` | — | Optional previous encryption key for rotation. Used only on the read path when the primary key fails to authenticate a v1: ciphertext. Never used for new writes. See `backend/docs/integrations.md` for the dual-key rotation procedure. |
| `LOGIN_LOCKOUT_THRESHOLD` | `5` | Failed login attempts before per-account lockout |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Lockout duration after threshold is hit |
| `AUTH_RATE_LIMIT_MAX` | `20` prod / `500` dev | Per-IP request cap (15 min window) for unauthenticated auth endpoints: login, register, refresh, logout, password reset, verify-email |
| `UPLOAD_RATE_LIMIT_MAX` | `200` prod / `5000` dev | Per-IP cap on POST /runs and POST /runs/upload |
| `API_RATE_LIMIT_MAX` | `1500` prod / `50000` dev | Per-IP cap on the global API surface (all authenticated routes below the upload + artifact + health buckets) |
| `ARTIFACT_RATE_LIMIT_MAX` | `3000` prod / `100000` dev | Per-IP cap on /uploads/* artifact serves (a release detail page renders dozens of screenshots — keep this high) |
| `HEALTH_RATE_LIMIT_MAX` | `600` | Per-IP cap on /health (load balancer probes bypass other limiters but get their own bucket) |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | tracks `NODE_ENV` (allowed in dev, blocked in prod) | When `true`, webhooks can target loopback / private IP ranges. Dev already allows it, so the local `--profile integrations` echo sink works out of the box; set `true` explicitly to allow it in production. SSRF gate stays in place for other schemes. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` | localhost / 1025 / — / — / `Flakey <noreply@example.com>` | SMTP settings for scheduled-report email delivery and auth verification/reset. Defaults target the bundled Mailpit (view sent mail at http://localhost:8025). |
| `FLAKEY_SSO_ENABLED` | `false` | Enables the enterprise SSO login flow (`/auth/sso/*`) + admin config API (`/sso/config`) — OIDC/SAML/SCIM, all OFF by default. GovRAMP-scoped auth control; see [backend/docs/sso.md](backend/docs/sso.md). |
| `PUBLIC_API_URL` | `http://localhost:3000` | Public backend base URL used to build the IdP redirect URI (`<PUBLIC_API_URL>/auth/sso/callback`). Required when `FLAKEY_SSO_ENABLED=true`. |
| `FLAKEY_AUDIT_EXPORT_ENABLED` | `false` | Enables audit-log SIEM export — durable, gap-free streaming of `audit_log` to a per-org HTTP (customer SIEM) or S3 destination, configured via the admin `/audit/export` API. OFF by default (flusher no-ops + routes 404). Tamper-evidence (`GET /audit/verify`) is always on, independent of this flag. GovRAMP-scoped logging control; see [backend/docs/audit-logging.md](backend/docs/audit-logging.md). |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Backend API URL |

### CLI

| Variable | Default | Description |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | — | API key for authentication |

<a id="self-host"></a>
## Self-host

Flakey is MIT-licensed and the entire stack — backend, frontend, reporters, infra — is in this repo. Two supported paths:

### Local / single-VM (Docker Compose)

```bash
git clone https://github.com/Absence0760/project-flakey.git
cd project-flakey
pnpm setup                       # install frontend + packages (pnpm) and backend (npm)
pnpm dev:all                     # infra (Postgres + Mailpit, waited healthy) + backend :3000 + frontend :7778
pnpm db:seed                     # once: sample data + a login (admin@example.com / admin)
```

The dev defaults run everything on one machine straight from a clone — backend and frontend each ship a committed `.env.development`. For production-like secrets, drop them in `backend/.env.development.local` (gitignored): generate real values with `openssl rand -hex 32`; `JWT_SECRET` and `FLAKEY_ENCRYPTION_KEY` are required in production (the backend refuses to boot without them when `NODE_ENV=production`). See [docs/run-locally.md](docs/run-locally.md).

### AWS (ECS Fargate + RDS + S3/CloudFront)

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit every <placeholder> — terraform refuses to plan otherwise.
# At minimum: app_name, aws_region, acm_certificate_arn,
# csp_connect_src (your API origin), budget_alert_email.
terraform init && terraform apply
```

Nothing in the stack hard-codes the upstream domain — every value is a Terraform variable. See [infra/README.md](infra/README.md) for the self-hoster checklist, the full setup walkthrough, and a cost breakdown (~$72/month for the default `db.t4g.micro` + minimal-traffic profile).

## Deployment

Same Terraform stack — see Self-host above.

**CI/CD pipelines** (GitHub Actions):
- `deploy.yml` — builds and deploys backend (Docker → ECS) and frontend (static → S3/CloudFront) on GitHub release publish (tag `app@*`) or manual dispatch
- `publish.yml` — publishes packages to npm on a matching release tag (e.g. `core@1.2.3`, `all@1.0.0`) or manual dispatch; see workflow for full tag format (`@flakeytesting/core`, `cli`, `cypress-reporter`, `cypress-snapshots`, `live-reporter`, `mcp-server`, `playwright-reporter`, `playwright-snapshots`, `webdriverio-reporter`)

## npm Packages

| Package | Description | Install |
|---|---|---|
| `@flakeytesting/core` | Shared API client and schema | `npm install @flakeytesting/core` |
| `@flakeytesting/cli` | CLI for uploading test results | `npm install @flakeytesting/cli` |
| `@flakeytesting/cypress-reporter` | Cypress reporter + plugin + support | `npm install @flakeytesting/cypress-reporter` |
| `@flakeytesting/cypress-snapshots` | Cypress DOM snapshot plugin | `npm install @flakeytesting/cypress-snapshots` |
| `@flakeytesting/live-reporter` | Live test-event streaming during a run | `npm install @flakeytesting/live-reporter` |
| `@flakeytesting/mcp-server` | MCP server for AI agent test queries | `npm install @flakeytesting/mcp-server` |
| `@flakeytesting/playwright-reporter` | Playwright reporter | `npm install @flakeytesting/playwright-reporter` |
| `@flakeytesting/playwright-snapshots` | Playwright trace parser for snapshots | `npm install @flakeytesting/playwright-snapshots` |
| `@flakeytesting/webdriverio-reporter` | WebdriverIO reporter | `npm install @flakeytesting/webdriverio-reporter` |

## Documentation

Repo-wide docs live in `docs/`. Package- and backend-specific docs live alongside their code.

**Repo-wide:**

- [Run locally](docs/run-locally.md)
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Overview](docs/overview.md) · [Competitor comparison](docs/competitors.md)
- [AWS deployment](infra/README.md)

**Backend:**

- [Integrations & automation](backend/docs/integrations.md) — Jira, PagerDuty, scheduled reports, coverage gating, secrets encryption
- [Reporters & normalizers](backend/docs/normalizer.md)
- [Migrations](backend/docs/migrations.md)
- [Testing](backend/docs/testing.md) — running the backend integration test suite
- [Manual tests](backend/docs/manual-tests.md)

**Packages:**

- [Uploading results](packages/flakey-cli/docs/uploading-results.md) — CLI uploaders (results, coverage, a11y, visual, UI coverage)
- [Reporter package design](packages/flakey-core/docs/reporter-package.md)
- [DOM snapshot plugin](packages/flakey-cypress-snapshots/docs/plugin.md)
- [Cypress background](packages/flakey-cypress-reporter/docs/cypress-background.md)

**Examples:** see [examples/README.md](examples/README.md) (Cypress, Playwright, Selenium, WebdriverIO, Postman, OWASP ZAP).
