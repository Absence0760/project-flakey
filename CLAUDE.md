# project-flakey

Self-hosted, CI-agnostic test reporting dashboard. Monorepo.

Product is branded as **"Better Testing"** in the UI (rebrand from "Flakey"). npm package scopes remain `@flakeytesting/*` and the repo directory is still `project-flakey` — do not rename those. When touching user-facing copy, prefer "Better Testing".

## Layout

- `backend/` — Express/Node/TS; uses **npm** (not pnpm)
- `frontend/` — SvelteKit (Svelte 5); uses pnpm workspace
- `packages/` — `@flakeytesting/*` npm packages
- `infra/` — Terraform: AWS ECS Fargate + RDS + S3/CloudFront

Each subdirectory has its own CLAUDE.md — read it before editing.

## Root commands

- `pnpm dev` — start backend (3000) and frontend (7777) concurrently
- `pnpm dev:backend` / `pnpm dev:frontend` — one at a time
- `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` — docker-compose Postgres lifecycle

## Package manager

- **Frontend + packages**: pnpm (workspace root is `packages/*`, see `pnpm-workspace.yaml`).
- **Backend**: uses its own `npm` lockfile. Don't run pnpm inside `backend/`.

## Branching & PRs

- Base branch for PRs: `main`.
- `dev` is a long-lived integration branch that tracks `main`.
- The Claude Code GitHub Action (`.github/workflows/claude.yml`) bases new branches off `main` and opens draft PRs against `main`.

## Publish flow

`publish.yml` publishes packages to npm on `main` when their source changes. Bump versions with an explicit commit.
