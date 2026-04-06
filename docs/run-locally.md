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

This starts PostgreSQL on port 5432 and runs the migrations in `backend/migrations/` automatically.

After the container is up, create the non-superuser app role (required for RLS tenant isolation):

```bash
PGHOST=localhost PGUSER=flakey PGPASSWORD=flakey PGDATABASE=flakey psql -c "
CREATE ROLE flakey_app LOGIN PASSWORD 'flakey_app';
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO flakey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO flakey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO flakey_app;
"
```

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

Create an API key in the Profile page, then use the CLI:

```bash
cd cli
npx tsx src/index.ts \
  --report-dir /path/to/reports \
  --suite my-suite \
  --branch main \
  --reporter mochawesome \
  --api-key fk_your_key_here
```

Or set the key as an environment variable:

```bash
export FLAKEY_API_KEY=fk_your_key_here
npx tsx src/index.ts --report-dir /path/to/reports --suite my-suite
```

Supported reporters: `mochawesome`, `junit`, `playwright`.

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
