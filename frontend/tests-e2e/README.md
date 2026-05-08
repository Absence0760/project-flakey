# tests-e2e/

Playwright end-to-end specs for the Better Testing dashboard. These cover surfaces that the frontend's vitest unit tests deliberately don't (Svelte 5 components, route loaders, the auth singleton, anything user-visible).

## Layout

```
tests-e2e/
  playwright.config.ts        # Playwright config (lives next to specs)
  fixtures/
    users.ts                  # SeededUser + ADMIN_USER / DEMO_USER constants
    helpers.ts                # signIn / signOut helpers shared by specs + globalSetup
    auth.ts                   # globalSetup — signs each user in once, writes .auth/<user>.json
  .auth/                      # storage states (gitignored)
  *.spec.ts                   # surface-scoped specs (one file per route or feature)
  cross-cutting/              # multi-route flows (sign-in-out, run-upload-and-view, …)
```

Add a new spec file when adding a route or a major affordance. Use `test.use({ storageState: ADMIN_USER.storageStatePath })` for tests that need to be signed in; use `test.use({ storageState: { cookies: [], origins: [] } })` for the unauthenticated cases (the /login surface, public-by-design pages).

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

| Constant | Email | Password | Role | Org |
|---|---|---|---|---|
| `ADMIN_USER` | `admin@example.com` | `admin` | admin | Acme Corp (`acme`) |
| `DEMO_USER` | `demo@example.com` | `demo123` | viewer | Demo Team (`demo-team`) |

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
