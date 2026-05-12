# tests-e2e/

Playwright end-to-end specs for the Flakey dashboard. These cover surfaces that the frontend's vitest unit tests deliberately don't (Svelte 5 components, route loaders, the auth singleton, anything user-visible).

## Layout

Specs are grouped into one directory per top-level page (matching the route
under `src/routes/(app)/<route>/`), plus a `live/` directory for the live-run
feature (which spans multiple routes) and a `cross-cutting/` directory for
flows that traverse several routes or test whole-app behaviour.

```
tests-e2e/
  playwright.config.ts        # Playwright config (lives next to specs)
  fixtures/
    users.ts                  # SeededUser + ADMIN_USER / DEMO_USER / VIEWER_USER constants
    helpers.ts                # signIn / signOut helpers shared by specs + globalSetup
    auth.ts                   # globalSetup — signs each user in once, writes .auth/<user>.json
  .auth/                      # storage states (gitignored)

  login/                      # /login + registration / verification / reset / switch-org
  dashboard/                  # /dashboard
  runs/                       # /runs (list + power-user views) + /runs/:id (detail)
  errors/                     # /errors + ErrorModal (keyboard / tabs / snapshot viewer)
  flaky/                      # /flaky
  slowest/                    # /slowest
  compare/                    # /compare
  manual-tests/               # /manual-tests (+ groups, requirements, runner)
  releases/                   # /releases (+ detail, sessions, sign-off chain)
  settings/                   # /settings (team, integrations, API keys, quarantine)
  live/                       # live-run feature (SSE + reporter adapters + lifecycle)
  cross-cutting/              # multi-route flows: branding, auth walls, cross-tenant,
                              # url-state bookmarking, upload bughunt, viewer-role, …
```

Add a new spec file under the matching page directory (or `cross-cutting/`
for whole-app flows). Use `test.use({ storageState: ADMIN_USER.storageStatePath })`
for tests that need to be signed in; use
`test.use({ storageState: { cookies: [], origins: [] } })` for the
unauthenticated cases (the /login surface, public-by-design pages).

Spec files import shared fixtures with `from "../fixtures/..."` (one
directory up from the page folder). The Playwright config's `testDir: "."`
recurses into every subdirectory; `testIgnore` excludes `fixtures/` and
`.auth/` so neither shows up as a spec file.

## Prerequisites

The Playwright `webServer` block starts the frontend dev server itself. The **backend API + seeded Postgres** is your responsibility — Playwright's globalSetup signs in via the form, which is a no-op if there's no backend to authenticate against.

```bash
# from the repo root
pnpm db:up                  # docker-compose Postgres on :5432
cd backend && ./migrate.sh  # apply migrations (host: localhost, user: flakey)
cd backend && npm run seed  # load admin + demo users + sample runs
cd backend && npm run dev   # API on :3000

# in another terminal, from frontend/
pnpm test:e2e               # spawns vite dev on :7777, runs globalSetup, runs specs
pnpm test:e2e:ui            # same, but with Playwright's UI runner
```

If the backend is on a different host, set `E2E_BACKEND_URL`:

```bash
E2E_BACKEND_URL=https://api.staging.example.com pnpm test:e2e
```

`VITE_API_URL` is propagated to the dev server from that env var so `frontend/src/lib/config.ts` resolves the right base.

## Seed credentials

| Constant | Email | Password | Org membership | Org |
|---|---|---|---|---|
| `ADMIN_USER` | `admin@example.com` | `admin` | owner | Acme Corp (`acme`) |
| `DEMO_USER` | `demo@example.com` | `demo123` | owner | Demo Team (`demo-team`) |
| `VIEWER_USER` | `viewer@example.com` | `viewer123` | viewer | Acme Corp (`acme`) |

Use `VIEWER_USER` for any "admin-only endpoint must 403 a viewer" assertion — it's the only seeded user with `org_members.role = 'viewer'`. `DEMO_USER` is an *owner* of an empty org (used for cross-tenant isolation + empty-state coverage), despite the legacy `users.role = 'viewer'` global field.

Source of truth: `backend/src/seed.ts`. If the seed changes, update `fixtures/users.ts` in lockstep.

## When to add a spec here vs a vitest

- **Add a vitest** for a pure helper in `src/lib/` with no DOM, no fetch, no auth singleton coupling.
- **Add a spec here** for everything else: a new route, a new component that mounts on a route, a flow that crosses login/logout, a regression in the live-stream SSE bus.

The Playwright config disables `fullyParallel` and runs a single worker because the suite shares one seeded DB. If a spec must be parallelisable later, scope its writes to a per-test org rather than relaxing the worker setting.

## Test discipline

When a test fails, **fix the app — don't soften the assertion**. The whole point of the suite is to catch regressions; a test that's been bent to pass against broken behaviour is worse than no test. If a test's premise is genuinely wrong (wrong selector, wrong API path, misunderstood spec), say so explicitly in the commit before editing the spec.

## CI

Not yet wired into CI. The workflow will need to:

1. Stand up Postgres (service container or docker-compose).
2. Run `migrate.sh` + `npm run seed` in `backend/`.
3. Start the backend API (`npm run dev` or `npm start` after `npm run build`) on `:3000` in the background.
4. From `frontend/`: `pnpm test:e2e`.
5. Upload the `playwright-report/` artifact.

Steps 3 and 4 are the only orchestration left — the webServer block in `playwright.config.ts` already handles the frontend lifecycle.
