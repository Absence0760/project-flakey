# project-flakey

Self-hosted, CI-agnostic test reporting dashboard. Monorepo.

Product is branded as **"Flakey"** in the UI (the earlier "Better Testing" rebrand was reverted). Domain: `flakey.io`. npm package scopes remain `@flakeytesting/*`, the repo directory is still `project-flakey`, and the auth singleton's localStorage keys keep the `bt_*` prefix — none of those are user-visible and there's no migration cost worth paying to flip them. When touching user-facing copy, use "Flakey".

## Layout

- `backend/` — Express/Node/TS; uses **npm** (not pnpm)
- `frontend/` — SvelteKit (Svelte 5); uses pnpm workspace
- `packages/` — `@flakeytesting/*` npm packages
- `infra/` — Terraform: AWS ECS Fargate + RDS + S3/CloudFront

Each subdirectory has its own CLAUDE.md — read it before editing.

## Where to look first

Start from the entry point for your task — don't rediscover what's already written down.

| If you're working on… | Read first |
|---|---|
| Getting the app running locally | [docs/run-locally.md](docs/run-locally.md) |
| System design, request flow, trust boundaries | [docs/architecture.md](docs/architecture.md) |
| Backend routes / auth / tenancy / RLS | [backend/CLAUDE.md](backend/CLAUDE.md) |
| A Postgres migration | [backend/docs/migrations.md](backend/docs/migrations.md) + the `/safe-migration` skill |
| Integrations (Jira, PagerDuty, git providers, webhooks) | [backend/docs/integrations.md](backend/docs/integrations.md) |
| Enterprise SSO (OIDC + SAML login, SCIM provisioning — all built, flag-gated) | [backend/docs/sso.md](backend/docs/sso.md) + [docs/proposals/phase-14-sso.md](docs/proposals/phase-14-sso.md) |
| A reporter normalizer (Mochawesome/JUnit/Playwright/…) | [backend/docs/normalizer.md](backend/docs/normalizer.md) |
| The pytest (Python) reporter | [packages/flakey-pytest-reporter/CLAUDE.md](packages/flakey-pytest-reporter/CLAUDE.md) (uv/hatchling — **not** in the pnpm workspace) |
| Frontend pages / components / auth singleton | [frontend/CLAUDE.md](frontend/CLAUDE.md) |
| The API contract / generated client types | [backend/openapi.yaml](backend/openapi.yaml) → `pnpm openapi:generate` → `frontend/src/lib/api-generated.ts`; `pnpm openapi:check` flags drift |
| Tests (unit / smoke / e2e conventions) | [backend/docs/testing.md](backend/docs/testing.md), [frontend/tests-e2e/README.md](frontend/tests-e2e/README.md) |
| Publishing an `@flakeytesting/*` package | [backend/docs/releases.md](backend/docs/releases.md) + the `Publish flow` section below |
| AWS infra | [infra/](infra/) (Terraform) |

## Root commands

Run everything from the repo root via pnpm — no need to `cd` into a workspace.

- `pnpm dev` — start backend (3000) and frontend (7778) concurrently
- `pnpm dev:backend` / `pnpm dev:frontend` — one at a time
- `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` — core local services (Postgres + Mailpit SMTP sink at http://localhost:8025). Migrations auto-apply on a fresh volume (compose mounts `backend/migrations` into `/docker-entrypoint-initdb.d`), so a reset leaves a migrated-but-empty DB — seed separately
- `pnpm db:seed` — load sample data (`cd backend && npm run seed`): `admin@example.com`/`admin` + demo users, sample orgs/runs, and worker tenants. **The seed is additive** — re-running adds another generation rather than resetting, so for a clean baseline run `pnpm db:reset && pnpm db:seed`, not `db:seed` twice
- `pnpm storage:up` / `pnpm storage:down` — opt-in MinIO (S3-compatible store; console http://localhost:9001) for exercising `STORAGE=s3` locally
- `pnpm webhooks:up` / `pnpm webhooks:down` — opt-in webhook echo sink (:8080) for inspecting outbound webhooks
- `pnpm ai:up` / `pnpm ai:down` — opt-in local Ollama (:11434, OpenAI-compatible) for the AI-analysis features; first `ai:up` downloads ~2 GB (llama3.2) into a volume. Set `AI_PROVIDER=openai` + `AI_BASE_URL=http://localhost:11434/v1` in `backend/.env` to use it. **AI is instance-wide, not per-org** — once configured, `isAIEnabled()` is true for every org. CPU-only under Docker on macOS; a native `ollama serve` (Metal) is faster (same `AI_BASE_URL`). Override the model with `OLLAMA_MODEL` (keep it in lockstep with `AI_MODEL`)
- `pnpm idp:up` / `pnpm idp:down` / `pnpm idp:reset` — opt-in local Keycloak (:8081) for prototyping + e2e-testing enterprise SSO **login** (OIDC/SAML, Phase 14 — built, flag-gated behind `FLAKEY_SSO_ENABLED`); seeds the `flakey` realm from `infra/keycloak/flakey-realm.json`. `idp:reset` recreates the container so realm edits re-import. See [backend/docs/sso.md](backend/docs/sso.md)
- `pnpm idp:scim:up` / `idp:scim:down` / `idp:scim:reset` — opt-in **Authentik** (:9002) + a mock SCIM target (:8082) for prototyping + e2e-testing SCIM **provisioning** (the half Keycloak can't do). Authentik pushes users/groups to `infra/scim-target/server.mjs`, which records them at `http://localhost:8082/_captured`. Heavier than `idp` (its own Postgres + Redis + worker), hence a separate profile. `idp:scim:reset` wipes volumes for a clean state
- `pnpm services:up` / `pnpm services:down` — bring up / tear down every local service at once
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

## Local ports

One reference so new services don't collide. Defaults — override via env where noted.

| Port | Service | Notes |
|---|---|---|
| 3000 | Backend API | `PORT`; health probe `GET /health` |
| 7778 | Frontend (Vite dev) | `pnpm dev:frontend` |
| 8888 | Frontend preview | `pnpm --filter frontend preview` |
| 5432 | Postgres | docker-compose; `DB_PORT` |
| 1025 | Mailpit SMTP | backend default `SMTP_PORT` |
| 8025 | Mailpit web UI | view captured mail |
| 9000 | MinIO S3 API | opt-in (`pnpm storage:up`); `S3_ENDPOINT` |
| 9001 | MinIO console | opt-in; `minioadmin` / `minioadmin` |
| 8080 | Webhook echo sink | opt-in (`pnpm webhooks:up`) |
| 11434 | Ollama (local LLM) | opt-in (`pnpm ai:up`); `AI_BASE_URL=http://localhost:11434/v1` |
| 8081 | Keycloak (local IdP) | opt-in (`pnpm idp:up`); admin `admin`/`admin`; realm `flakey` |
| 8082 | Mock SCIM target | opt-in (`pnpm idp:scim:up`); captures at `/_captured` |
| 9002 | Authentik (local IdP) | opt-in (`pnpm idp:scim:up`); admin `akadmin`/`akadminpassword` |

## Package manager

- **Frontend + packages**: pnpm (workspace root is `packages/*`, see `pnpm-workspace.yaml`).
- **Backend**: uses its own `npm` lockfile. Don't run pnpm inside `backend/`.

## Gotchas

Footguns that have bitten before — check here before assuming something's broken.

- **Two package managers.** `backend/` uses **npm** (its own lockfile, outside the pnpm workspace); `frontend/` + `packages/` use **pnpm**. Don't cross them.
- **`pnpm db:up` now also starts Mailpit** (not just Postgres) — the script name is historical. `pnpm services:up` adds the opt-in MinIO + webhook sink.
- **Type codegen is partial (migration in progress).** `backend/openapi.yaml` is the API contract source of truth and generates `frontend/src/lib/api-generated.ts` via `pnpm openapi:generate` (openapi-typescript). It currently covers the **core** surface (runs/tests/errors/stats/flaky/compare/auth); the rest of `frontend/src/lib/api.ts` + `backend/src/types.ts` are still **hand-synced** with the DB. So: a schema change still means editing all relevant sides yourself (use `/safe-migration`), AND — if the route is in the spec — updating `openapi.yaml` in the same commit (`pnpm openapi:check` flags drift). Extend the spec as you touch routes; don't let it rot.
- **RLS runs as a non-superuser.** The backend connects as `flakey_app` so Row-Level Security applies. Connecting as a superuser silently bypasses tenant isolation — don't.
- **Encryption key falls back to plaintext.** With `FLAKEY_ENCRYPTION_KEY` unset, integration secrets are stored as plaintext (local-dev only — the backend refuses to boot this way in production).
- **`bt_*` localStorage keys are intentional.** The brand is "Flakey" but auth keys keep the `bt_` prefix (a Better-Testing holdover) so existing sessions survive — don't "fix" them.
- **e2e needs the full stack + seed.** `pnpm test:e2e` and `pnpm test:backend` require `pnpm db:up` and a seeded DB (`cd backend && npm run seed`); they don't spin services up for you.
- **Artifact cleanup is app-driven; the S3 lifecycle is a backstop.** Per-org `retention_days` prunes runs nightly and `backend/src/retention.ts` deletes their S3 artifacts in the same pass. The Terraform S3 lifecycle (`infra/variables.tf` → `artifact_retention_days`, default 365d) only sweeps orphans the app delete misses — keep that cap **≥ the largest per-org retention** or it'll expire artifacts ahead of policy. Don't add a second "delete artifacts" path in the routes; extend `storage.deleteRun`.

## Guard rails

Standing rules for how to work in this repo. They are not optional; when in
doubt, follow the rule and say so.

1. **Commit each piece of work.** Land every logical unit as its own
   path-scoped commit as you finish it — never batch unrelated changes or leave
   the tree dirty across tasks. (Detail + the scope-guard hook: see
   [Git workflow](#git-workflow) below.)
2. **Never push.** `git push` is the operator's call — never push from an
   interactive session. (See [Git workflow](#git-workflow).)
3. **Always add test coverage where possible.** A behavior change ships with
   tests in the same session — unit / smoke / e2e as the change warrants (see
   the per-area test conventions in `backend/`, `frontend/`, and `packages/`).
   If something is genuinely untestable, say *why* rather than skipping
   silently.
4. **Code-review important code.** For non-trivial or load-bearing changes
   (auth, tenancy/RLS, migrations, gate signals, money/PII paths), run a review
   pass before committing — `/check`, `/safe-edit`, or the `code-reviewer`
   agent. Don't gate trivial edits (typos, comments, dep bumps) on it.
5. **Never code around an issue — fix the root cause.** No masking: no inflated
   timeouts, sleeps, retries, skipped/loosened assertions, swallowed errors, or
   try/catch that hides a real failure. If you can't fix it now, surface it
   explicitly; don't half-mask it. (Full list for tests:
   [Fix bugs at the source](#fix-bugs-at-the-source--never-adjust-the-test-to-hide-them).)
6. **Always recommend the long-term solution.** When a quick patch and a
   durable fix diverge, name the durable fix and its tradeoffs even if you also
   ship the patch — don't let an expedient workaround pass as the answer.
7. **Local-first.** Every part of the app must run on a dev laptop with no
   cloud account. External dependencies ship with a local equivalent (Postgres
   + Mailpit by default; MinIO + a webhook sink behind opt-in Compose profiles)
   *and* a code default that points at it (`STORAGE=local`, `SMTP_PORT=1025`, AI
   off unless configured). When you add a dependency on an external service, add
   its local equivalent and a safe local default in the *same* change — never
   make `pnpm dev` require a real SaaS credential. (See
   [docs/run-locally.md](docs/run-locally.md).)
8. **A pnpm script per service.** Every service or long-running process a
   contributor starts in dev gets a root `package.json` script — don't make
   anyone memorize raw `docker compose --profile …` / tool invocations
   (`pnpm db:up`, `pnpm storage:up`, `pnpm webhooks:up`, `pnpm services:up`).
   Add the script in the same change you add the service.
9. **Reusable Svelte components.** Build UI from shared components in
   `frontend/src/lib/components/` (grouped by kind — `charts/`, `media/`,
   `inputs/`, `overlays/`, `panels/`, `status/`) instead of copy-pasting markup
   across routes; extract a component the second time you'd duplicate it.
   Svelte 5 runes only (`$state`/`$derived`/`$effect`/`$props`) — see
   [frontend/CLAUDE.md](frontend/CLAUDE.md).
10. **Organize files by responsibility.** Put code in the file/dir its siblings
    already establish (backend: `src/routes/`, `src/integrations/`,
    `src/git-providers/`, `src/normalizers/`; frontend: `src/lib/{stores,utils,
    components}` + `api.ts`). Don't dump unrelated logic into a file just because
    it's open — create or extend the file that owns that responsibility. Read the
    per-subdirectory `CLAUDE.md` before editing, and respect each area's package
    manager (npm in `backend/`, pnpm in `frontend/` + `packages/`).
11. **Never bypass tenant isolation.** The backend runs as the non-superuser
    `flakey_app` so Postgres RLS applies; route tenant-scoped data through
    `tenantQuery`/`tenantTransaction`, and add an RLS policy in the *same*
    migration that adds a tenant table. Don't connect as a superuser or reach
    around RLS with bare `pool.query` on tenant data. (Established in
    [backend/CLAUDE.md](backend/CLAUDE.md); enforced by the `/audit/multi-tenant`
    sweep.)
12. **Docs-as-code — update docs in the same turn as the change.** A behaviour,
    command, env var, port, or convention change updates its docs in the same
    commit, not "later" — deferred docs are drift. Touch the affected
    `README.md` / `docs/*` / per-area `CLAUDE.md`, and add a new convention here
    or in the relevant `CLAUDE.md`. The `doc-hygiene-checker` agent and `/check`
    enforce this; don't make them do the catching.

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

## Git workflow

- **Commit each piece of work; never push.** Land every logical unit of work as its own path-scoped commit (`git commit -m "…" -- path/to/file …`) as you finish it — don't leave the tree dirty across tasks or batch unrelated changes into one commit. **Never `git push`** from an interactive session; publishing is the operator's call. (CI automation — the `claude.yml` GitHub Action described below — is exempt: it branches off `main` and opens its own draft PRs.)
- Path-scoped commits are also required by the `.claude/hooks/git-scope-guard.py` PreToolUse hook (concurrent sessions share one checkout) — bare `git commit`, `git add -A/.`, `git commit -a`, and whole-tree ops are blocked. If a git command is denied, follow the scoped alternative in its message.
- No `Co-Authored-By` / "Generated with" trailer in commits or PRs — write them as a human would.

## Branching & PRs

- Base branch for PRs: `main`.
- `dev` is a long-lived integration branch that tracks `main`.
- The Claude Code GitHub Action (`.github/workflows/claude.yml`) bases new branches off `main` and opens draft PRs against `main`.

## Publish flow

`publish.yml` publishes packages to npm when a GitHub release is published with a matching tag (`<package>@<version>`, e.g. `core@1.2.3`; use `all@<version>` for all packages). To publish: bump the version in the package's `package.json`, merge to `main`, then create a GitHub release with the matching tag.

## If this file is wrong, fix it

This file is the orientation other sessions start from — an out-of-date one is worse than none. If you find a command, port, path, or convention here that no longer matches reality, correct it in the same change (per guard rail 12), don't work around it.
