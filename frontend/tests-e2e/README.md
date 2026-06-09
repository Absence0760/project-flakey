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
pnpm test:e2e               # spawns vite dev on :7778, runs globalSetup, runs specs
pnpm test:e2e:ui            # same, but with Playwright's UI runner
```

If the backend is on a different host, set `E2E_BACKEND_URL`:

```bash
E2E_BACKEND_URL=https://api.staging.example.com pnpm test:e2e
```

`VITE_API_URL` is propagated to the dev server from that env var so `frontend/src/lib/utils/config.ts` resolves the right base.

## Seed credentials

Primary trio (kept stable across runs — pinned specs reference these):

| Constant | Email | Password | Org membership | Org |
|---|---|---|---|---|
| `ADMIN_USER` | `admin@example.com` | `admin` | owner | Acme Corp (`acme`) |
| `DEMO_USER` | `demo@example.com` | `demo123` | owner | Demo Team (`demo-team`) |
| `VIEWER_USER` | `viewer@example.com` | `viewer123` | viewer | Acme Corp (`acme`) |

Worker tenants (one fully-populated org per Playwright worker — see Parallelism below):

| Constant | Email | Password | Org membership | Org |
|---|---|---|---|---|
| `WORKER_USERS[0]` | `admin+w0@example.com` | `worker0123` | owner (admin) | `acme-w0` |
| `WORKER_USERS[1]` | `admin+w1@example.com` | `worker1123` | owner (admin) | `acme-w1` |
| `WORKER_USERS[2]` | `admin+w2@example.com` | `worker2123` | owner (admin) | `acme-w2` |
| `WORKER_USERS[3]` | `admin+w3@example.com` | `worker3123` | owner (admin) | `acme-w3` |

Use `VIEWER_USER` for any "admin-only endpoint must 403 a viewer" assertion — it's the only seeded user with `org_members.role = 'viewer'`. `DEMO_USER` is an *owner* of an empty org (used for cross-tenant isolation + empty-state coverage), despite the legacy `users.role = 'viewer'` global field.

Source of truth: `backend/src/seed.ts`. If the seed changes (number of worker tenants, passwords, org slugs), update `fixtures/users.ts` in lockstep.

## Parallelism

Playwright runs four workers by default (`workers: 4`, `fullyParallel: true`). Each worker (`parallelIndex` 0..3) signs in as its matching `WORKER_USERS[i]` admin and operates exclusively on `acme-w<i>` — fully populated by `npm run seed` with the same ~85 runs / 55 releases / 78 manual tests as Acme. Write-heavy specs no longer collide because no two workers share a tenant.

How it works:

```ts
// fixtures/test.ts re-exports a wrapped `test` whose default
// storageState resolves to the worker's admin tenant.
import { test, expect } from "../fixtures/test";

test.describe("/dashboard", () => {
  // No test.use({ storageState: ... }) needed — the per-worker
  // default kicks in. This spec runs on whichever tenant the
  // worker is bound to (acme-w0, w1, w2, or w3).
  test("renders the KPI cards", async ({ page }) => { ... });
});
```

Specs that need a specific user (Acme admin for sign-in form tests, `VIEWER_USER` for role-403, `DEMO_USER` for the cross-tenant pair) keep their explicit `test.use({ storageState: ... })` — describe-level `test.use` wins over the wrapper's default. For cross-tenant tests that open a second context, use the `workerAdminStorageState` worker-scoped fixture to keep the second context on the same tenant:

```ts
test.beforeAll(async ({ browser, workerAdminStorageState }) => {
  const ctx = await browser.newContext({ storageState: workerAdminStorageState });
  // ...
});
```

Tuning:

- `PLAYWRIGHT_WORKERS=1 pnpm test:e2e` — serialize for debugging.
- `E2E_WORKER_TENANTS=8 npm run seed` (in backend) + `PLAYWRIGHT_WORKERS=8 pnpm test:e2e` (in frontend) — scale up. Keep both values in lockstep; the wrapper does `parallelIndex % WORKER_USERS.length` so a mismatch silently shares tenants across workers and re-introduces the original collision problem.
- `E2E_WORKER_TENANTS=0 npm run seed` — skip the worker tenants entirely (ship-a-slim-prod-seed mode); the suite then needs `PLAYWRIGHT_WORKERS=1` so the per-worker fixture has a tenant to point at.

## When to add a spec here vs a vitest

- **Add a vitest** for a pure helper in `src/lib/` with no DOM, no fetch, no auth singleton coupling.
- **Add a spec here** for everything else: a new route, a new component that mounts on a route, a flow that crosses login/logout, a regression in the live-stream SSE bus.

The suite runs four workers in parallel (`fullyParallel: true`), each bound to its own seeded `acme-w<N>` tenant via `fixtures/test.ts`. When you add a new spec, import `test` from `../fixtures/test` so it inherits per-worker isolation by default. Don't reach for `ADMIN_USER` unless the spec genuinely needs Acme (form-flow tests, cross-tenant pairs, or assertions on a specific user's email/name).

## Test discipline

When a test fails, **fix the app — don't soften the assertion**. The whole point of the suite is to catch regressions; a test that's been bent to pass against broken behaviour is worse than no test. If a test's premise is genuinely wrong (wrong selector, wrong API path, misunderstood spec), say so explicitly in the commit before editing the spec.

## Readiness signals (don't sleep)

`page.waitForTimeout(...)` is banned (see the root `CLAUDE.md` guard rail). Wait on a real signal instead. Each `(app)` route exposes two content-agnostic readiness attributes on its top-level `.page` element:

- **`data-ready="true"`** — flips once the route's `onMount` fetch has settled (resolved **or** errored) and the page has rendered. Use it instead of probing for content that may legitimately be empty (e.g. `/flaky` with no flaky tests, a freshly-registered worker tenant with no runs). The attribute is absent until ready, so both `[data-ready]` (presence) and `[data-ready="true"]` match only when ready.
- **`data-sse-connected="true"`** — on `/runs` only; flips once the `/live/stream` EventSource has delivered its first message (the backend sends a `snapshot` on connect). Wait on it before firing `/live/start` so an add/remove delta can't race a not-yet-open stream. It resets to absent if the stream drops.

Example:

```ts
await page.goto("/flaky");
await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
// …now assert on the rendered listing
```

When you add a new route, add `data-ready` (and `data-sse-connected` if it opens a live stream) in the same change so specs have a stable gate. For UI elements whose only honest "done" signal is a disabled/enabled state (e.g. a submit button guarded on a non-empty field), assert that state directly rather than clicking and sleeping.

## CI

Wired into [`.github/workflows/tests.yml`](../../.github/workflows/tests.yml) — the `e2e` job runs on every PR and every push to `main` (skipped on docs-only PRs). It:

1. Stands up Postgres 16 as a service container (tmpfs-backed), matching `docker-compose.yml`.
2. Runs `./migrate.sh` + `npm run seed` in `backend/` (the seed creates the `flakey_app` role and the per-worker `acme-w<N>` tenants the fixtures bind to).
3. Starts the backend on `:3000` in the background with a freshly-generated `JWT_SECRET` and waits on `/health`. The frontend lifecycle is handled by the `webServer` block in `playwright.config.ts`.
4. Runs Playwright as a **14-shard matrix** (`--shard=N/14`). The job is independent — it stands up its own Postgres + backend + seed, so it's not gated on the `backend` job and runs in parallel for faster feedback.
5. Uploads each shard's `playwright-report/` as an artifact (`playwright-report-shard-N`, 14-day retention).

`retries: 1` on CI (see `playwright.config.ts`) still absorbs incidental dev-server/HMR noise. With the `data-ready` / `data-sse-connected` readiness signals now in place (see above), the SSE-timing class of flake it was covering is gone; dropping to `0` is a reasonable next step once a stretch of green shard runs confirms no residual flake.

## SSO / SCIM proofs (Phase 14 prototype)

`tests-e2e/sso/` proves enterprise auth is e2e-testable against local IdPs with
no online signup. It has its **own** config (`tests-e2e/sso/playwright.sso.config.ts`)
— no `globalSetup`, no `webServer` — because it drives the IdPs directly and
needs neither the Flakey app nor a seeded Postgres. Bring both IdPs up, then run:

```bash
pnpm idp:up && pnpm idp:scim:up    # repo root — Keycloak :8081, Authentik :9002 + SCIM target :8082
cd frontend && pnpm test:e2e:sso
```

- **`keycloak-oidc.spec.ts`** (needs `pnpm idp:up`) — a full Authorization-Code +
  PKCE flow through Keycloak's hosted login UI headlessly (fills the form,
  follows the redirect, exchanges the code, asserts the token carries `email` +
  `flakey_roles`), plus a negative bad-credentials path.
- **`authentik-scim.spec.ts`** (needs `pnpm idp:scim:up`) — drives a real SCIM
  outbound sync from Authentik into the mock target (`infra/scim-target/`):
  create an IdP user → assert provisioned (user + role group); deactivate →
  assert deprovisioned (`active:false`). APIs only — uses Playwright's `request`
  fixture, no browser page.

SSO itself is **not built yet** (see
[docs/proposals/phase-14-sso.md](../../docs/proposals/phase-14-sso.md)); when it
lands, the app-facing SSO specs move under the main config (they need the app up)
and this IdP-only config stays as the contract proof.
