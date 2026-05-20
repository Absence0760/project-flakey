# project-flakey

Self-hosted, CI-agnostic test reporting dashboard. Monorepo.

Product is branded as **"Flakey"** in the UI (the earlier "Better Testing" rebrand was reverted). Domain: `flakey.io`. npm package scopes remain `@flakeytesting/*`, the repo directory is still `project-flakey`, and the auth singleton's localStorage keys keep the `bt_*` prefix — none of those are user-visible and there's no migration cost worth paying to flip them. When touching user-facing copy, use "Flakey".

## Layout

- `backend/` — Express/Node/TS; uses **npm** (not pnpm)
- `frontend/` — SvelteKit (Svelte 5); uses pnpm workspace
- `packages/` — `@flakeytesting/*` npm packages
- `infra/` — Terraform: AWS ECS Fargate + RDS + S3/CloudFront

Each subdirectory has its own CLAUDE.md — read it before editing.

## Root commands

Run everything from the repo root via pnpm — no need to `cd` into a workspace.

- `pnpm dev` — start backend (3000) and frontend (7778) concurrently
- `pnpm dev:backend` / `pnpm dev:frontend` — one at a time
- `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` — docker-compose Postgres lifecycle
- `pnpm install:backend` — runs `npm install` inside `backend/` (the only workspace outside the pnpm tree)
- `pnpm build` — builds packages → backend → frontend (build:packages first so reporter dist/ is fresh)
- `pnpm build:backend` / `pnpm build:frontend` / `pnpm build:packages` — one at a time
- `pnpm check` — backend `tsc --noEmit` + `pnpm check:frontend` (svelte-kit sync + svelte-check)
- `pnpm check:backend` / `pnpm check:frontend` — one at a time
- `pnpm test` — backend → packages → frontend unit (vitest). Does NOT include e2e — that needs running services
- `pnpm test:backend` — `node --test` over `backend/src/tests/**/*.test.ts` (needs `db:up` + seed)
- `pnpm test:frontend` — vitest pure-helper unit tests
- `pnpm test:packages` — `node --test` per `@flakeytesting/*` package
- `pnpm test:e2e` — Playwright e2e (needs full stack running + seeded DB)
- `pnpm test:examples` — runs the shared example fixtures against a live backend

## Package manager

- **Frontend + packages**: pnpm (workspace root is `packages/*`, see `pnpm-workspace.yaml`).
- **Backend**: uses its own `npm` lockfile. Don't run pnpm inside `backend/`.

## Branching & PRs

- Base branch for PRs: `main`.
- `dev` is a long-lived integration branch that tracks `main`.
- The Claude Code GitHub Action (`.github/workflows/claude.yml`) bases new branches off `main` and opens draft PRs against `main`.

## Publish flow

`publish.yml` publishes packages to npm when a GitHub release is published with a matching tag (`<package>@<version>`, e.g. `core@1.2.3`; use `all@<version>` for all packages). To publish: bump the version in the package's `package.json`, merge to `main`, then create a GitHub release with the matching tag.
