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
cd ../packages/cli && npm install
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

### Cypress (Mochawesome)

```bash
npx tsx packages/cli/src/index.ts \
  --report-dir cypress/reports \
  --suite my-project \
  --api-key $FLAKEY_API_KEY
```

### Playwright

```bash
npx tsx packages/cli/src/index.ts \
  --report-dir playwright-report \
  --suite my-project \
  --reporter playwright \
  --api-key $FLAKEY_API_KEY
```

### JUnit XML (Jest, pytest, Go, etc.)

```bash
npx tsx packages/cli/src/index.ts \
  --report-dir test-results \
  --suite my-project \
  --reporter junit \
  --api-key $FLAKEY_API_KEY
```

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

### Test Analysis
- **Run detail** — progress ring, status filters, test search, collapsible specs
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

### Integrations
- **PR/MR comments** — auto-posts test summary (pass rate, failures, flaky tests, trend) as a PR/MR comment on GitHub, GitLab, or Bitbucket; updates existing comment on re-runs
- **Webhook notifications** — rich formatted messages for Slack (Block Kit), Teams (Adaptive Cards), Discord (Embeds), or generic JSON
- **Status badges** — embeddable SVG badge for READMEs: `![tests](https://your-flakey/badge/my-suite)`

### Admin
- Team management (invite, roles, remove)
- Suite management (rename, archive, delete)
- Data retention (auto-delete runs older than N days)
- Audit log

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
| Reporters | Mochawesome, JUnit XML, Playwright JSON |

## CI Integration

### GitHub Actions

```yaml
- name: Upload results
  if: always()
  run: npx tsx packages/cli/src/index.ts --report-dir cypress/reports --suite my-project
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
  - npx tsx packages/cli/src/index.ts --report-dir cypress/reports --suite my-project
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
- `publish.yml` — publishes `@flakey/cli` and `@flakey/cypress-snapshots` to npm when their source changes

## npm Packages

| Package | Description | Install |
|---|---|---|
| `@flakey/cli` | CLI for uploading test results | `npm install @flakey/cli` |
| `@flakey/cypress-snapshots` | Cypress DOM snapshot plugin | `npm install @flakey/cypress-snapshots` |

## Documentation

See the `docs/` directory:

- [Run locally](docs/run-locally.md)
- [Architecture](docs/architecture.md)
- [Uploading results](docs/uploading-results.md)
- [Reporters & normalizers](docs/normalizer.md)
- [AWS deployment](infra/README.md)
- [Roadmap](docs/roadmap.md)
- [DOM snapshot plugin](docs/cypress-snapshot-plugin.md)
