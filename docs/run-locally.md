# Run Locally

## Prerequisites

- [Docker](https://www.docker.com/) (for PostgreSQL, Mailpit, and the optional MinIO / webhook services)
- [Node.js](https://nodejs.org/) v22+ (CI runs 22/24)
- [pnpm](https://pnpm.io/) (for the frontend)

## Setup

### 1. Start the local services

```bash
pnpm db:up
```

This starts the services every local run needs:

- **PostgreSQL** on port 5432 — runs all migrations in `backend/migrations/` automatically, including creating the `flakey_app` database role needed for RLS tenant isolation.
- **Mailpit** — a local SMTP sink on port 1025 (the backend's default `SMTP_PORT`) with a web UI at **http://localhost:8025**. All transactional mail (email verification, password reset, scheduled reports) lands there instead of a real inbox. No backend config needed.

The remaining external dependencies are local-first by default, so nothing else is required to run the app:

- **Artifact storage** defaults to local disk (`uploads/`).
- **AI analysis** is off unless you configure a provider.
- **Integrations** (Jira, PagerDuty, git providers, webhooks) are per-org and idle until configured.

Two optional services let you exercise the cloud code paths locally, behind Compose profiles so they don't start by default:

```bash
# S3-compatible artifact storage (MinIO) — console at http://localhost:9001
pnpm storage:up

# Outbound-webhook echo sink on :8080 — inspect with `docker compose logs -f webhook-sink`
pnpm webhooks:up

# Everything at once
pnpm services:up
```

To point the backend at MinIO, set `STORAGE=s3` and the `S3_ENDPOINT` block in `backend/.env` (see the [env table](#backend) below — the example file ships the values pre-filled and commented).

### 2. Install dependencies

```bash
# Backend (npm, not pnpm — backend has its own lockfile)
cd backend && npm install

# Frontend
cd frontend && pnpm install

# CLI (optional, for uploading results)
cd packages/flakey-cli && pnpm install
```

### 3. Set up environment variables

```bash
# Backend
cp backend/.env.example backend/.env

# Frontend (defaults work out of the box)
cp frontend/.env.example frontend/.env

# CLI (optional)
cp packages/flakey-cli/.env.example packages/flakey-cli/.env
```

The defaults work for local development. No changes needed unless you're using non-standard ports.

### 4. Seed sample data (optional)

```bash
cd backend && npm run seed
```

This creates:
- Three users:
  - `admin@example.com` / `admin` — owner of Acme Corp
  - `demo@example.com` / `demo123` — owner of Demo Team
  - `viewer@example.com` / `viewer123` — viewer-role member of Acme Corp
- Two organizations: Acme Corp (admin's) and Demo Team (demo's)
- 56 sample test runs spread across 18 months (50 main + 3 Playwright + 3 JUnit, assigned to Acme Corp)
- Phase 9/10 sample data attached to Acme Corp:
  - Coverage, accessibility, and visual-diff reports on the 3 most recent runs
  - 10 known UI routes (7 visited, 3 untested) for the UI coverage view
  - 5 manual tests across varied statuses (passed, failed, blocked, not run)
  - Release `v2.4.0` with a partially completed sign-off checklist
  - A weekly regression scheduled report
- Demoable extras (for the Settings page and CLI/integration testing):
  - A known admin API key `fk_demoadmindemoadmindemoadmindemoa` for CLI testing
  - One webhook target (`https://example.invalid/seeded-hook`)
  - Two quarantine entries on existing failed tests
  - Two non-default error-group statuses (investigating, known)
  - One pending org invite (`token: demo-invite-token-do-not-use-in-prod-aaaa`)
- **4 worker tenants** (`admin+w{0..3}@example.com` / `worker{0..3}123`, orgs `acme-w{0..3}`) with the same playground content as Acme, so parallel Playwright workers each get a dedicated tenant. Override the count with `E2E_WORKER_TENANTS=N` (default 4; set to 0 for a slim production seed).

### 5. Start the backend and frontend

From the project root:

```bash
pnpm dev
```

This starts both services concurrently:

- **Backend API** — http://localhost:3000
- **Frontend** — http://localhost:7778

### 6. Log in

Open http://localhost:7778 and log in with:

- **Email:** `admin@example.com`
- **Password:** `admin`

Or register a new account — a personal organization is created automatically.

### 7. Upload test results

All data endpoints require authentication. You have three options:

#### Option A: Get a token and upload with curl (quickest)

```bash
# 1. Get a JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

# 2. Upload a mochawesome report
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"meta\":{\"suite_name\":\"my-project\",\"branch\":\"main\",\"commit_sha\":\"\",\"ci_run_id\":\"\",\"started_at\":\"\",\"finished_at\":\"\",\"reporter\":\"mochawesome\"},\"raw\":$(cat path/to/mochawesome.json)}"
```

#### Option B: Create an API key and use curl (recommended for CI)

1. Log in at http://localhost:7778
2. Go to **Settings** (sidebar)
3. Under **API Keys**, enter a label and click **Create key**
4. Copy the key (starts with `fk_`) — it's only shown once

```bash
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fk_your_key_here" \
  -d "{\"meta\":{\"suite_name\":\"my-project\",\"branch\":\"main\",\"commit_sha\":\"\",\"ci_run_id\":\"\",\"started_at\":\"\",\"finished_at\":\"\",\"reporter\":\"mochawesome\"},\"raw\":$(cat path/to/mochawesome.json)}"
```

#### Option C: Use the CLI uploader

```bash
cd packages/flakey-cli

# With --api-key flag
npx tsx src/index.ts \
  --report-dir /path/to/reports \
  --suite my-suite \
  --branch main \
  --reporter mochawesome \
  --api-key fk_your_key_here

# Or with environment variable
export FLAKEY_API_KEY=fk_your_key_here
npx tsx src/index.ts \
  --report-dir /path/to/reports \
  --suite my-suite \
  --branch main
```

#### Supported reporters

| Reporter | Flag | Report file |
|---|---|---|
| Mochawesome | `--reporter mochawesome` | `.json` (Cypress/Mocha) |
| JUnit | `--reporter junit` | `.xml` (Jest, pytest, Go, Java, .NET) |
| Playwright | `--reporter playwright` | `.json` (Playwright JSON reporter) |
| Jest | `--reporter jest` | `.json` (Jest `--json` output) |
| WebdriverIO | `--reporter webdriverio` | `.json` (WDIO JSON reporter) |

## Useful commands

| Command | Description |
|---|---|
| `pnpm db:up` | Start core services — PostgreSQL + Mailpit (http://localhost:8025) |
| `pnpm storage:up` / `pnpm storage:down` | Start / stop MinIO (S3-compatible; console http://localhost:9001) |
| `pnpm webhooks:up` / `pnpm webhooks:down` | Start / stop the webhook echo sink (:8080) |
| `pnpm services:up` / `pnpm services:down` | Start / stop every local service at once |
| `pnpm db:down` | Stop the core services |
| `pnpm db:reset` | Stop core services, delete data, and restart |
| `pnpm dev` | Start backend + frontend |
| `pnpm dev:backend` | Start backend only |
| `pnpm dev:frontend` | Start frontend only |
| `cd backend && npm run seed` | Seed sample data |
| `cd backend && npm test` | Run the Phase 9/10 integration smoke tests (see [backend/docs/testing.md](../backend/docs/testing.md)) |

## Environment variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `flakey_app` | Database user (non-superuser for RLS) |
| `DB_PASSWORD` | `flakey_app` | Database password |
| `DB_NAME` | `flakey` | Database name |
| `PORT` | `3000` | API server port |
| `NODE_ENV` | — | Set `production` to refuse boot without `JWT_SECRET` + `FLAKEY_ENCRYPTION_KEY` and to apply the production-tier rate-limit defaults (see [README.md](../README.md#environment-variables) for the full per-bucket table) |
| `CORS_ORIGINS` | `http://localhost:7778,http://localhost:3000` | Comma-separated allow-list. Dev default covers the Vite dev server (7778) and the API itself (3000) for same-machine probes |
| `JWT_SECRET` | `flakey-dev-secret-change-me` | JWT signing secret (change in production) |
| `ALLOW_REGISTRATION` | `false` | Set `true` to allow self-serve registration; default is invite-only |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Set `true` to require email verification |
| `FRONTEND_URL` | `http://localhost:7778` | Used for email links and PR comments |
| `STORAGE` | `local` | `local` or `s3` for artifact storage |
| `S3_BUCKET` | _(none)_ | S3 bucket name (when `STORAGE=s3`) |
| `S3_REGION` | `us-east-1` | AWS region (when `STORAGE=s3`) |
| `S3_ENDPOINT` | _(none)_ | Custom endpoint for an S3-compatible store (e.g. `http://localhost:9000` for the bundled MinIO). Unset = real AWS S3 |
| `S3_FORCE_PATH_STYLE` | `true` when `S3_ENDPOINT` is set | Path-style bucket addressing; required for MinIO. Set `false` to opt back out |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | _(none)_ | S3 credentials (standard AWS chain). For local MinIO: `minioadmin` / `minioadmin` |
| `AI_PROVIDER` | _(none)_ | `anthropic` or `openai` for AI analysis |
| `AI_BASE_URL` | _(none)_ | API URL for OpenAI-compatible models (e.g. `http://localhost:11434/v1` for Ollama) |
| `AI_API_KEY` | _(none)_ | API key for the AI provider |
| `AI_MODEL` | auto | Model name (defaults to `claude-haiku-4-5-20251001` for Anthropic, `llama3.2` for OpenAI) |
| `SMTP_HOST` | `localhost` | SMTP server for email verification + scheduled-report email delivery. Defaults target the bundled Mailpit (view sent mail at http://localhost:8025) |
| `SMTP_PORT` | `1025` | SMTP port (Mailpit's SMTP listener) |
| `SMTP_USER` | _(none)_ | SMTP username (optional, only if your relay requires auth) |
| `SMTP_PASSWORD` | _(none)_ | SMTP password |
| `SMTP_SECURE` | `false` | Set `true` for TLS |
| `EMAIL_FROM` | `Flakey <noreply@example.com>` | From-address used for all outgoing email |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | tracks `NODE_ENV` (allowed in dev, blocked in prod) | Allow webhooks to target private / loopback hosts. Dev already permits it, so the local `--profile integrations` sink works out of the box; set `true` to allow it in production |
| `FLAKEY_ENCRYPTION_KEY` | _(none)_ | 32-byte base64 or hex key for AES-256-GCM encryption of Jira / PagerDuty secrets. Unset = plaintext passthrough (refused in `NODE_ENV=production`). See [backend/docs/integrations.md](../backend/docs/integrations.md#secrets-encryption) |
| `FLAKEY_ENCRYPTION_KEY_OLD` | _(none)_ | Optional previous encryption key for rotation — read-path only, never used for new writes. See [backend/docs/integrations.md](../backend/docs/integrations.md#secrets-encryption) for the dual-key rotation procedure |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Backend API URL |

### CLI

| Variable | Default | Description |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | _(none)_ | API key for authentication |
