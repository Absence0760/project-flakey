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

## Fix bugs at the source — never adjust the test to hide them

When a test fails, the only acceptable resolution paths are:

1. **The test itself is broken** (wrong fixture, missing required field, typo, race in test setup, unique-constraint collision with seed data). Fix the test.
2. **The app has a real bug or missing primitive.** Fix the app code. If the app needs a new affordance for the test to wait deterministically (a `data-ready` attribute backed by a real readiness signal, an exposed status, a broadcast handshake), add it in the app code — it's a real API, not test scaffolding.

There is no third option. These are forbidden because they ship the bug behind a green check:

- Inflating a Playwright `expect` / `toBeVisible` timeout to absorb a flake (`5_000` → `15_000` → `30_000`). Fix whatever makes the page slow.
- `await page.waitForTimeout(N)` between two actions. Wait on a real signal (DOM node, state attribute, network response).
- Bumping `--retries` (or relying on Playwright's `retries: 1`) to mask a real race.
- `test.skip(…)` / `test.fixme(…)` / `test.fail(…)` against a real bug without an open follow-up that names what's broken + when it'll be fixed.
- Loosening strict assertions (`toHaveText('foo')` → `toContainText(/foo|bar|.*/i)`) to "absorb variance" — the variance IS the bug.
- Replacing a real wait with a sleep "because the real signal is unreliable" — the real signal needs fixing.

If you spot a candidate fix that fits one of those patterns: stop, surface the underlying app issue, and either fix it in the same session or flag it explicitly. Don't half-mask it via the test.

## Branching & PRs

- Base branch for PRs: `main`.
- `dev` is a long-lived integration branch that tracks `main`.
- The Claude Code GitHub Action (`.github/workflows/claude.yml`) bases new branches off `main` and opens draft PRs against `main`.

## Publish flow

`publish.yml` publishes packages to npm when a GitHub release is published with a matching tag (`<package>@<version>`, e.g. `core@1.2.3`; use `all@<version>` for all packages). To publish: bump the version in the package's `package.json`, merge to `main`, then create a GitHub release with the matching tag.
