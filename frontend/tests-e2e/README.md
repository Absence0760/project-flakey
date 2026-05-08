# tests-e2e/

Playwright end-to-end specs for the Better Testing dashboard. These cover surfaces that the frontend's vitest unit tests deliberately don't (Svelte 5 components, route loaders, the auth singleton, anything user-visible).

## Prerequisites

The Playwright `webServer` config starts the frontend preview server itself, but the **backend + seeded Postgres** is your responsibility:

```bash
# from the repo root
pnpm db:up                  # docker-compose Postgres on :5432
cd backend && ./migrate.sh  # apply migrations (host: localhost, user: flakey)
cd backend && npm run seed  # load admin@example.com / admin + sample runs
cd backend && npm run dev   # API on :3000

# in another terminal, from frontend/
pnpm test:e2e               # spawns vite preview on :8888 + runs specs
pnpm test:e2e:ui            # same, but with Playwright's UI runner
```

If the backend is on a different host, set `E2E_BACKEND_URL`:

```bash
E2E_BACKEND_URL=https://api.staging.example.com pnpm test:e2e
```

The frontend's preview server picks up `VITE_API_URL` from that env var so `frontend/src/lib/config.ts` resolves the right base.

## Seed credentials

| Email | Password | Role | Org |
|---|---|---|---|
| `admin@example.com` | `admin` | admin | Acme Corp |
| `demo@example.com` | `demo123` | viewer | Demo Team |

Source of truth: `backend/src/seed.ts`. If the seed changes, update this table and the spec constants in lockstep.

## CI

These specs are **not yet wired into CI**. To wire them in, the workflow needs to:

1. Stand up Postgres (service container or docker-compose).
2. Run `migrate.sh` + `npm run seed` in `backend/`.
3. Start `npm run dev` (or `npm start` after `npm run build`) on `:3000` in the background.
4. From `frontend/`: `pnpm test:e2e`.
5. Upload the `playwright-report/` artifact.

The webServer block in `playwright.config.ts` handles the frontend lifecycle, so steps 3 and 4 are the only orchestration left.

## When to add an e2e (vs a vitest)

- **Add a vitest** for a pure helper in `src/lib/` with no DOM, no fetch, no auth singleton coupling.
- **Add an e2e** for everything else: a new route, a new component that mounts on a route, a flow that crosses login/logout, a regression in the live-stream SSE bus, anything you'd otherwise verify by hand.

The Playwright config disables `fullyParallel` because the suite shares a single seeded DB — tests aren't isolated by default. If a spec must be isolated, use `test.describe.serial` or scope writes to a per-test org.
