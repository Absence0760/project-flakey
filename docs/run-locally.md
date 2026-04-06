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
cd backend && npm install

# Frontend
cd frontend && pnpm install

# CLI (optional, for uploading results)
cd cli && npm install
```

### 3. Seed sample data (optional)

```bash
cd backend && npm run seed
```

This creates:
- Two users: `admin@flakey.dev` / `admin` and `demo@flakey.dev` / `demo123`
- Two organizations: Acme Corp (admin's) and Demo Team (demo's)
- 50 sample test runs spread across 18 months (assigned to Acme Corp)

### 4. Start the backend and frontend

From the project root:

```bash
npm run dev
```

This starts both services concurrently:

- **Backend API** — http://localhost:3000
- **Frontend** — http://localhost:7777

### 5. Log in

Open http://localhost:7777 and log in with:

- **Email:** `admin@flakey.dev`
- **Password:** `admin`

Or register a new account — a personal organization is created automatically.

### 6. Upload test results

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
2. Go to **Profile** (bottom of sidebar)
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

## Useful commands

| Command | Description |
|---|---|
| `docker compose up -d` | Start PostgreSQL |
| `docker compose down` | Stop PostgreSQL |
| `docker compose down -v` | Stop PostgreSQL and delete data |
| `npm run dev` | Start backend + frontend |
| `npm run dev:backend` | Start backend only |
| `npm run dev:frontend` | Start frontend only |
| `cd backend && npm run seed` | Seed sample data |

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

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Backend API URL |

### CLI

| Variable | Default | Description |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | _(none)_ | API key for authentication |
