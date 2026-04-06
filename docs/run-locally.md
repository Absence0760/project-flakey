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

This starts PostgreSQL on port 5432 and runs the migration in `backend/migrations/001_initial.sql` automatically.

### 2. Install dependencies

```bash
# Backend
cd backend && npm install

# Frontend
cd frontend && pnpm install

# CLI (optional, for uploading results)
cd cli && npm install
```

### 3. Start the backend and frontend

From the project root:

```bash
npm run dev
```

This starts both services concurrently:

- **Backend API** — http://localhost:3000
- **Frontend** — http://localhost:7777

### 4. Upload test results

From an external repo that runs Cypress (or any framework using mochawesome), use the CLI:

```bash
cd cli
npx tsx src/index.ts --report-dir /path/to/reports --suite my-suite --branch main
```

Or POST directly to the API:

```bash
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -d @path/to/payload.json
```

### 5. View results

Open http://localhost:7777 to see uploaded test runs.

## Useful commands

| Command | Description |
|---|---|
| `docker compose up -d` | Start PostgreSQL |
| `docker compose down` | Stop PostgreSQL |
| `docker compose down -v` | Stop PostgreSQL and delete data |
| `npm run dev` | Start backend + frontend |
| `npm run dev:backend` | Start backend only |
| `npm run dev:frontend` | Start frontend only |

## Environment variables

The backend uses these defaults which match the Docker Compose config:

| Variable | Default |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` |
| `DB_USER` | `flakey` |
| `DB_PASSWORD` | `flakey` |
| `DB_NAME` | `flakey` |
| `PORT` | `3000` |
