# Flakey

A self-hosted, CI-agnostic test reporting dashboard. Collects test results from Cypress, Playwright, Jest, pytest, and any framework that outputs Mochawesome JSON, JUnit XML, or Playwright JSON. Displays results with trend charts, flaky test detection, and failure analysis.

Multi-tenant with organization-based isolation via Postgres Row-Level Security. JWT + API key authentication.

## Quick Start

### Prerequisites

- [Docker](https://www.docker.com/) (for PostgreSQL)
- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) (for the frontend)

### 1. Start the database

```bash
docker compose up -d
```

### 2. Install dependencies

```bash
cd backend && npm install
cd ../frontend && pnpm install
cd ../packages/flakey-cli && npm install
```

### 3. Seed sample data

```bash
cd backend && npm run seed
```

Creates two users, two orgs, and 56 sample test runs (Mochawesome, Playwright, JUnit).

### 4. Start the app

```bash
npm run dev
```

- **Frontend:** http://localhost:7777
- **API:** http://localhost:3000

### 5. Log in

- **Email:** `admin@flakey.dev`
- **Password:** `admin`

## Upload Test Results

### Cypress (recommended)

```bash
npm install --save-dev @flakeytesting/cypress-reporter @flakeytesting/cypress-snapshots
```

```typescript
// cypress.config.ts
import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin";
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  },
  e2e: {
    setupNodeEvents(on, config) {
      flakeyReporter(on, config);
      flakeySnapshots(on, config);
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

Results, screenshots, videos, and DOM snapshots are uploaded automatically when the run finishes.

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
npx flakey-cli coverage --run-id 42 --file coverage/coverage-summary.json

# Accessibility (axe-core results)
npx flakey-cli a11y --run-id 42 --file axe-results.json --url /

# Visual regression diffs
npx flakey-cli visual --run-id 42 --file visual-manifest.json

# UI coverage — record which routes tests visited
npx flakey-cli ui-coverage --suite my-e2e --file visits.json --run-id 42
```

See [docs/uploading-results.md](docs/uploading-results.md#uploading-quality-metrics) for the expected file formats.

### Postman (Newman)

```bash
newman run collection.json --reporters junit --reporter-junit-export results.xml
npx flakey-cli upload --report-dir . --suite api-tests --reporter junit
```

### OWASP ZAP

ZAP results can be converted to JUnit XML and uploaded. See `examples/zap/` for a working converter script.

### curl

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@flakey.dev","password":"admin"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"meta\":{\"suite_name\":\"my-project\",\"branch\":\"main\",\"commit_sha\":\"\",\"ci_run_id\":\"\",\"started_at\":\"\",\"finished_at\":\"\",\"reporter\":\"mochawesome\"},\"raw\":$(cat cypress/reports/mochawesome.json)}"
```

Create an API key from the Profile page for permanent access (no expiry).

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
- **Slowest tests** — ranked by duration with P50/P95/P99 percentiles, trend analysis (getting slower/faster), mini sparkline, and expandable duration history chart
- **Error tracking** — failures grouped by error message with status (open/investigating/known/fixed/ignored), first/last seen, affected run count, and team notes thread
- **Test history** — pass/fail timeline for a single test across runs
- **Compare runs** — side-by-side diff showing regressions, fixes, and unchanged tests

### Reporter Metadata
- **Playwright:** retry history, tags, annotations, source location, stdout/stderr, error snippets
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
- **Webhook notifications** — rich formatted messages for Slack (Block Kit), Teams (Adaptive Cards), Discord (Embeds), or generic JSON
- **Status badges** — embeddable SVG badge for READMEs: `![tests](https://your-flakey/badge/my-suite)`
- **Secrets encryption at rest** — Jira tokens and PagerDuty keys are AES-256-GCM encrypted (via `FLAKEY_ENCRYPTION_KEY`); gracefully falls back to plaintext in local dev

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
| `DB_USER` | `flakey_app` | Database user (non-superuser for RLS) |
| `DB_PASSWORD` | `flakey_app` | Database password |
| `PORT` | `3000` | API port |
| `CORS_ORIGINS` | `http://localhost:7777` | Allowed origins (comma-separated) |
| `FRONTEND_URL` | `http://localhost:7777` | Frontend URL (used in webhook notification links) |
| `ALLOW_REGISTRATION` | `true` | Set `false` for invite-only registration |
| `NODE_ENV` | — | Set `production` to enforce JWT_SECRET and strict CORS |
| `FLAKEY_ENCRYPTION_KEY` | — | 32-byte key (base64 or hex) for AES-256-GCM encryption of Jira/PagerDuty secrets. Unset = plaintext passthrough (local dev). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` | — | SMTP settings for scheduled-report email delivery and auth verification/reset |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Backend API URL |

### CLI

| Variable | Default | Description |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | — | API key for authentication |

## Deployment

Deploy to AWS with Terraform (ECS Fargate + RDS + S3/CloudFront):

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars
terraform init && terraform apply
```

See [infra/README.md](infra/README.md) for full setup guide and cost breakdown (~$72/month).

**CI/CD pipelines** (GitHub Actions):
- `deploy.yml` — builds and deploys backend (Docker → ECS) and frontend (static → S3/CloudFront) on push to `main`
- `publish.yml` — publishes `@flakeytesting/cli`, `@flakeytesting/cypress-reporter`, `@flakeytesting/playwright-reporter`, `@flakeytesting/webdriverio-reporter`, and `@flakeytesting/cypress-snapshots` to npm when their source changes

## npm Packages

| Package | Description | Install |
|---|---|---|
| `@flakeytesting/core` | Shared API client and schema | `npm install @flakeytesting/core` |
| `@flakeytesting/cli` | CLI for uploading test results | `npm install @flakeytesting/cli` |
| `@flakeytesting/cypress-reporter` | Cypress reporter + plugin + support | `npm install @flakeytesting/cypress-reporter` |
| `@flakeytesting/cypress-snapshots` | Cypress DOM snapshot plugin | `npm install @flakeytesting/cypress-snapshots` |
| `@flakeytesting/playwright-reporter` | Playwright reporter | `npm install @flakeytesting/playwright-reporter` |
| `@flakeytesting/playwright-snapshots` | Playwright trace parser for snapshots | `npm install @flakeytesting/playwright-snapshots` |
| `@flakeytesting/webdriverio-reporter` | WebdriverIO reporter | `npm install @flakeytesting/webdriverio-reporter` |

## Documentation

See the `docs/` directory:

- [Run locally](docs/run-locally.md)
- [Architecture](docs/architecture.md)
- [Uploading results](docs/uploading-results.md) — includes coverage, a11y, visual regression, and UI coverage uploaders
- [Integrations & automation](docs/integrations.md) — Jira, PagerDuty, scheduled reports, coverage gating, secrets encryption
- [Testing](docs/testing.md) — running the backend integration test suite
- [Reporters & normalizers](docs/normalizer.md)
- [Migrations](docs/migrations.md)
- [AWS deployment](infra/README.md)
- [Examples](docs/examples.md) (Cypress, Playwright, Selenium, WebdriverIO, Postman, OWASP ZAP)
- [Roadmap](docs/roadmap.md)
- [DOM snapshot plugin](docs/cypress-snapshot-plugin.md)
