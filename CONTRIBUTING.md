# Contributing to Flakey

Thanks for thinking about contributing. This guide covers the practical stuff: how to get the repo running, what the layout is, and how PRs land.

## Repo layout

```
backend/        Express + TypeScript API, multi-tenant via Postgres RLS
frontend/       SvelteKit + Svelte 5 dashboard
packages/       Published @flakeytesting/* npm packages (reporters, CLI, MCP)
infra/          AWS Terraform stack (ECS Fargate + RDS + S3/CloudFront)
docs/           User-facing documentation
examples/       Working consumer examples per framework
tests-e2e/      Playwright tests against the dashboard (lives under frontend/)
```

Each subdirectory has its own `CLAUDE.md` with the conventions specific to that area — read it before sending a PR that touches that subdirectory.

## Local setup

```bash
git clone https://github.com/Absence0760/project-flakey.git
cd project-flakey
pnpm install
pnpm db:up                              # Postgres in Docker
cp backend/.env.example backend/.env    # edit JWT_SECRET, FLAKEY_ENCRYPTION_KEY
pnpm db:reset                           # apply migrations + seed sample data
pnpm dev                                # backend :3000, frontend :7778
```

Seeded login: `admin@example.com` / `admin`. See `backend/CLAUDE.md` for the full seed manifest.

## Package managers

- **`backend/`** uses **npm** (has its own lockfile, intentionally outside the pnpm workspace).
- **`frontend/`** and **`packages/*`** use **pnpm** (workspace at the repo root).

Don't mix them. `pnpm install` inside `backend/` and `npm install` inside `packages/*` both break the lockfiles.

## Running tests

```bash
# Backend unit + smoke (Node test runner against tsx)
cd backend && npm test

# Frontend vitest (pure-helper unit tests)
cd frontend && pnpm test

# E2E (Playwright, hits the dev server)
cd frontend && pnpm test:e2e

# Per-package tests
pnpm -r --filter "@flakeytesting/*" test
```

## Where things go

| Change type | Path |
|---|---|
| New API endpoint | `backend/src/routes/` + smoke test in `backend/src/tests/` + update `docs/architecture.md` |
| New migration | `backend/migrations/NNN_description.sql` (idempotent: `IF NOT EXISTS`, `OR REPLACE`, `DROP POLICY IF EXISTS` before `CREATE POLICY`) |
| New reporter feature | `packages/flakey-<framework>-reporter/src/` + unit test in the same package |
| New dashboard view | `frontend/src/routes/(app)/<page>/+page.svelte` |
| Pure helper that needs testing | `frontend/src/lib/*.ts` (vitest) — component-level UX is covered by Playwright, not vitest |

## Conventions

- **Svelte 5 runes only.** Use `$state`, `$derived`, `$effect`, `$props`. Don't regress to Svelte 4 `let`/`$:`/`export let` reactivity.
- **RLS is load-bearing.** Backend routes against tenant tables go through `tenantQuery` or `tenantTransaction` (sets `app.current_org_id`). A raw `pool.query` against `runs`/`specs`/`tests` is a bug.
- **No tracking, no analytics.** Self-hosted means self-hosted — the dashboard makes zero outbound calls beyond the configured backend.
- **No emoji in commits.** Project uses `type(scope): subject` Conventional-Commits-ish format; see `git log` for examples.

## PR workflow

1. Fork + branch off `main`.
2. Make the change. If it's user-facing, update the relevant `docs/*.md` and the matching `CLAUDE.md`.
3. Run the test suites listed above. CI will run them too — failing locally is faster.
4. Open a PR against `main`. Include a 1-line problem statement and a 1-line fix description; the diff explains the rest.

## Security

If you've found a security issue, please **don't** open a public issue. See [SECURITY.md](SECURITY.md) for the disclosure process.

## License

By contributing you agree your work is licensed under the MIT License (see [LICENSE](LICENSE)).
