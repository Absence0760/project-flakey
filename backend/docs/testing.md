# Testing

Flakey's backend ships with an integration smoke-test suite that covers
the Phase 9 / 10 feature set (Jira, PagerDuty, scheduled reports, coverage,
accessibility, visual regression, UI coverage, manual tests, releases).

The tests use the built-in `node:test` runner — no new test frameworks,
no new dependencies.

## Running the tests

### 1. Start postgres

The tests talk to the real Postgres instance and expect all migrations
to be applied. If you already have dev state you want to keep, skip this
step.

```bash
docker compose up -d postgres
```

### 1b. Start Mailpit (for the email-delivery tests)

`email.smoke.test.ts` asserts that auth emails are *actually delivered* by
reading them back out of [Mailpit](https://mailpit.axllent.org/), the local
SMTP sink. `pnpm db:up` starts Mailpit alongside Postgres (SMTP on `1025`,
web UI + API on `8025`), so the simplest one-liner for both is:

```bash
pnpm db:up   # Postgres + Mailpit
```

The email tests poll the Mailpit API until each message lands; if Mailpit
isn't reachable they fail fast with an actionable message rather than hang.
Override the API base with `MAILPIT_URL` if it isn't on `http://localhost:8025`.

### 2. Run the suite

```bash
cd backend
npm test
```

The test runner:

1. Spawns the backend on port `3999` (so it does not collide with a
   running `pnpm dev` on `3000`)
2. Waits for `/health` to return `ok`
3. Registers a fresh user with a unique email per run
4. Uploads a baseline run so metrics uploads have a target
5. Exercises every Phase 9/10 endpoint
6. Kills the backend on suite completion

Each `test(...)` block prints a `✔` line, ending with a `ℹ tests N / ℹ pass N / ℹ fail 0` summary. The suite grows as endpoints are added — run `npm test` for the current list and count rather than relying on a number quoted here.

Full runtime: ~5–10 seconds (the stale-abort test waits 2.5 s for the timeout detector).

Note: a separate `crypto.test.ts` adds 7 more tests; `npm test` runs all files matching `src/tests/**/*.test.ts`.

## What each test covers

The table below is a representative subset, not an exhaustive list — the suite has grown beyond these rows. Run `npm test` for the full set.

| Test | Validates |
|---|---|
| `jira settings default + update` | GET returns defaults (no token, `Bug` issue type), PATCH persists, subsequent GET reports `has_api_token: true` without leaking the token |
| `pagerduty settings update` | Key + severity + auto-trigger persist, GET hides the key but reports `has_key: true` |
| `scheduled reports CRUD` | Create (201), toggle active via PATCH, list reflects the change, DELETE removes the row |
| `coverage upload + retrieval` | POST `/coverage` with Istanbul-style payload, GET `/coverage/runs/:id` returns the same numeric percentages |
| `a11y upload scoring` | Weighted impact scoring (100 − 15c − 8s − 4m − 1min) — 1 critical + 1 serious + 1 moderate → score 73 |
| `visual diffs create + review` | Bulk upload of diff records, PATCH to approve a diff, list view reflects the new status |
| `ui coverage summary + untested` | Known routes inventory + visits intersect correctly; 2/3 covered → `coverage_pct: 66.7`; untested endpoint returns the missing route |
| `manual tests CRUD + result recording` | Create (status `not_run`), POST result (status becomes `passed`, notes saved), summary counts reflect the change |
| `release checklist + sign-off enforcement` | Default checklist is created, sign-off refuses while required items are unchecked, after all required items are checked sign-off succeeds and status becomes `signed_off` |
| `manual test groups / bulk-link` | Create group, assign test to group, bulk-link the group's tests into a release (idempotent re-link returns 0 new links) |
| `release sessions: create, record, fail, accept, auto-complete` | Create session, record result, auto-complete when last test reaches terminal state, accept failure as known issue, revoke acceptance, start `failures_only` session |
| `manual test requirements: link, rollup, unlink` | Attach Jira requirement, verify provider inference from URL, confirm requirement appears in test detail, unlink |
| `live run abort: POST /abort` | `/live/start` → explicit abort removes run from active set, persists `run.aborted` event with the supplied reason |
| `live run abort: stale timeout` | Run started but never receives events; auto-abort after `FLAKEY_LIVE_TIMEOUT_MS` (set to 1500 ms in tests); confirmed via active set and history |
| `GET /runs marks aborted flag` | Aborted run surfaces `aborted: true` and `aborted_reason` in both list and detail responses |
| `POST /live/:runId/snapshot` | Upload gz blob; assert key naming, `snapshot_path` linkage on the `tests` row, filename sanitization, and 404 on foreign `runId` |
| `idempotent upsert (test.started)` | Two identical `test.started` events produce exactly one `tests` row (`030_tests_pending_unique` unique index) |
| `pending → passed transition` | `test.started` creates a pending row counted under `skipped`; `test.passed` transitions the row and adjusts run totals correctly |
| `upload-over-live-spec merge` | Live path creates a spec row via `spec.finished`; subsequent `/runs` POST merges into it (ON CONFLICT DO UPDATE) instead of rolling back |

## Environment variables

The test runner respects the usual DB env vars (with sensible defaults
for local Postgres):

| Variable | Default |
|---|---|
| `DB_USER` | `flakey_app` |
| `DB_PASSWORD` | `flakey_app` |
| `DB_NAME` | `flakey` |
| `DB_HOST` | `localhost` |

It hard-codes `JWT_SECRET=smoke-test-secret` and
`ALLOW_REGISTRATION=true` so the child backend starts cleanly.

## Adding more tests

Drop another `*.test.ts` file under `backend/src/tests/`. The glob in
`package.json` (`src/tests/**/*.test.ts`) picks it up automatically on the
next `npm test`.

The Phase 9/10 suite is intentionally scoped as a **single test file with
shared setup** — one spawn of the backend for every test in the file — because
spinning up the Express stack is the slowest part. If you add a new test
that needs its own isolated state, either:

- Extend `phase_9_10.smoke.test.ts` with another `test(...)` block (fastest)
- Or create a second file that uses a different `PORT` so the two files
  can run in parallel without colliding

**Smoke-test ports must be globally unique.** `node --test` runs test *files*
concurrently (up to the core count), so any two files that bind the same port
will intermittently fail with `EADDRINUSE` / `ECONNREFUSED` whenever they're
scheduled at the same time — a flake that only some CI runs hit. Pick a port no
other file uses (the lower `3900+` band is sparse), and verify uniqueness before
committing — grep matches `PORT`, `PORT_OPEN`, `RECEIVER_PORT`, etc.:

```sh
grep -rhoE "(PORT[A-Z_]*|_PORT) *= *[0-9]+" src/tests/*.ts \
  | grep -oE "[0-9]+$" | sort | uniq -d   # any output = a collision to fix
```

## CI

The real wiring lives in `.github/workflows/tests.yml` (the `backend` job).
You need Postgres running with all migrations applied, **and** a Mailpit
service for the email-delivery tests, before the step:

```yaml
# GitHub Actions — see .github/workflows/tests.yml for the maintained version
services:
  postgres:
    image: postgres:16-alpine
    # … env + healthcheck …
  mailpit:                       # SMTP sink for email.smoke.test.ts
    image: axllent/mailpit:latest
    ports: ["1025:1025", "8025:8025"]
    env:
      MP_SMTP_AUTH_ACCEPT_ANY: 1
      MP_SMTP_AUTH_ALLOW_INSECURE: 1
steps:
  - run: ./backend/migrate.sh
  - run: cd backend && npm ci && npm run seed && npm test
    env:
      DB_USER: flakey_app
      DB_PASSWORD: flakey_app
```

The suite is deterministic and does not reach the public internet:
Jira/PagerDuty calls are not exercised (their `test` endpoints are checked
separately in manual smoke tests), and the only network dependency is the
local Mailpit sink, which the email tests talk to over `MAILPIT_URL`.
