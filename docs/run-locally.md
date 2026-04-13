# Run Locally

## Prerequisites

- [Docker](https://www.docker.com/) (for PostgreSQL)
- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (for the frontend)

## Setup

### 1. Start the database

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 and runs all migrations in `backend/migrations/` automatically, including creating the `flakey_app` database role needed for RLS tenant isolation.

### 2. Install dependencies

```bash
# Backend
cd backend && pnpm install

# Frontend
cd frontend && pnpm install

# CLI (optional, for uploading results)
cd cli && pnpm install
```

### 3. Set up environment variables

```bash
# Backend
cp backend/.env.example backend/.env

# Frontend (defaults work out of the box)
cp frontend/.env.example frontend/.env

# CLI (optional)
cp cli/.env.example cli/.env
```

The defaults work for local development. No changes needed unless you're using non-standard ports.

### 4. Seed sample data (optional)

```bash
cd backend && pnpm run seed
```

This creates:
- Two users: `admin@flakey.dev` / `admin` and `demo@flakey.dev` / `demo123`
- Two organizations: Acme Corp (admin's) and Demo Team (demo's)
- 50 sample test runs spread across 18 months (assigned to Acme Corp)
- Phase 9/10 sample data attached to Acme Corp:
  - Coverage, accessibility, and visual-diff reports on the 3 most recent runs
  - 10 known UI routes (7 visited, 3 untested) for the UI coverage view
  - 5 manual tests across varied statuses (passed, failed, blocked, not run)
  - Release `v2.4.0` with a partially completed sign-off checklist
  - A weekly regression scheduled report

### 5. Start the backend and frontend

From the project root:

```bash
npm run dev
```

This starts both services concurrently:

- **Backend API** — http://localhost:3000
- **Frontend** — http://localhost:7777

### 6. Log in

Open http://localhost:7777 and log in with:

- **Email:** `admin@flakey.dev`
- **Password:** `admin`

Or register a new account — a personal organization is created automatically.

### 7. Upload test results

All data endpoints require authentication. You have three options:

#### Option A: Get a token and upload with curl (quickest)

```bash
# 1. Get a JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@flakey.dev","password":"admin"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

# 2. Upload a mochawesome report
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"meta\":{\"suite_name\":\"my-project\",\"branch\":\"main\",\"commit_sha\":\"\",\"ci_run_id\":\"\",\"started_at\":\"\",\"finished_at\":\"\",\"reporter\":\"mochawesome\"},\"raw\":$(cat path/to/mochawesome.json)}"
```

#### Option B: Create an API key and use curl (recommended for CI)

1. Log in at http://localhost:7777
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
cd cli

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
| `docker compose up -d` | Start PostgreSQL |
| `docker compose down` | Stop PostgreSQL |
| `docker compose down -v` | Stop PostgreSQL and delete data |
| `pnpm run dev` | Start backend + frontend |
| `pnpm run dev:backend` | Start backend only |
| `pnpm run dev:frontend` | Start frontend only |
| `cd backend && pnpm run seed` | Seed sample data |
| `cd backend && pnpm test` | Run the Phase 9/10 integration smoke tests (see [testing.md](testing.md)) |

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
| `JWT_SECRET` | `flakey-dev-secret-change-me` | JWT signing secret (change in production) |
| `ALLOW_REGISTRATION` | `true` | Set `false` for invite-only registration |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Set `true` to require email verification |
| `FRONTEND_URL` | `http://localhost:7777` | Used for email links and PR comments |
| `STORAGE` | `local` | `local` or `s3` for artifact storage |
| `S3_BUCKET` | _(none)_ | S3 bucket name (when `STORAGE=s3`) |
| `S3_REGION` | `us-east-1` | AWS region (when `STORAGE=s3`) |
| `AI_PROVIDER` | _(none)_ | `anthropic` or `openai` for AI analysis |
| `AI_BASE_URL` | _(none)_ | API URL for OpenAI-compatible models (e.g. `http://localhost:11434/v1` for Ollama) |
| `AI_API_KEY` | _(none)_ | API key for the AI provider |
| `AI_MODEL` | auto | Model name (defaults to `claude-haiku-4-5-20251001` for Anthropic, `llama3.2` for OpenAI) |
| `SMTP_HOST` | `localhost` | SMTP server for email verification + scheduled-report email delivery |
| `SMTP_PORT` | `1025` | SMTP port |
| `SMTP_USER` | _(none)_ | SMTP username (optional, only if your relay requires auth) |
| `SMTP_PASSWORD` | _(none)_ | SMTP password |
| `SMTP_SECURE` | `false` | Set `true` for TLS |
| `EMAIL_FROM` | `Flakey <noreply@flakey.dev>` | From-address used for all outgoing email |
| `FLAKEY_ENCRYPTION_KEY` | _(none)_ | 32-byte base64 or hex key for AES-256-GCM encryption of Jira / PagerDuty secrets. Unset = plaintext passthrough. See [integrations.md](integrations.md#secrets-encryption) |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Backend API URL |

### CLI

| Variable | Default | Description |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | _(none)_ | API key for authentication |
