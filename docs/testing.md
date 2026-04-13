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

### 2. Run the suite

```bash
cd backend
pnpm test
```

The test runner:

1. Spawns the backend on port `3999` (so it does not collide with a
   running `pnpm dev` on `3000`)
2. Waits for `/health` to return `ok`
3. Registers a fresh user with a unique email per run
4. Uploads a baseline run so metrics uploads have a target
5. Exercises every Phase 9/10 endpoint
6. Kills the backend on suite completion

Expected output:

```
✔ jira settings default + update
✔ pagerduty settings update
✔ scheduled reports CRUD
✔ coverage upload + retrieval
✔ a11y upload scoring
✔ visual diffs create + review
✔ ui coverage summary + untested
✔ manual tests CRUD + result recording
✔ release checklist + sign-off enforcement
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Full runtime: ~1 second after the backend has booted.

## What each test covers

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

## Environment variables

The test runner respects the usual DB env vars (with sensible defaults
for local Postgres):

| Variable | Default |
|---|---|
| `DB_USER` | `flakey` |
| `DB_PASSWORD` | `flakey` |
| `DB_NAME` | `flakey` |
| `DB_HOST` | `localhost` |

It hard-codes `JWT_SECRET=smoke-test-secret` and
`ALLOW_REGISTRATION=true` so the child backend starts cleanly.

## Adding more tests

Drop another `*.test.ts` file under `backend/src/tests/`. The glob in
`package.json` (`src/tests/**/*.test.ts`) picks it up automatically on the
next `pnpm test`.

The Phase 9/10 suite is intentionally scoped as a **single test file with
shared setup** — one spawn of the backend for all nine tests — because
spinning up the Express stack is the slowest part. If you add a new test
that needs its own isolated state, either:

- Extend `phase_9_10.smoke.test.ts` with another `test(...)` block (fastest)
- Or create a second file that uses a different `PORT` so the two files
  can run in parallel without colliding

## CI

Wire it into your CI as a normal pnpm script. You need Postgres running
and all migrations applied before the step:

```yaml
# GitHub Actions example
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: pnpm
- run: docker compose up -d postgres
- run: ./backend/migrate.sh
- run: cd backend && pnpm install && pnpm test
  env:
    DB_USER: flakey
    DB_PASSWORD: flakey
```

The suite is deterministic and does not depend on external network
access (Jira/PagerDuty calls are not exercised — their `test` endpoints
are checked separately in manual smoke tests).
