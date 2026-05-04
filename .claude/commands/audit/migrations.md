---
description: Migrations are idempotent, every table has RLS, types are in sync between backend / frontend / DB
---

Audit `backend/migrations/` for idempotency, RLS coverage, and type-drift between the schema and the application's TypeScript types.

## Goal

Migrations are applied on every container boot via the docker-compose `docker-entrypoint-initdb.d` mount AND by `backend/migrate.sh` against existing DBs. They must be safe to re-run. Schema columns referenced by `backend/src/types.ts` and `frontend/src/lib/api.ts` must actually exist. A column added to the DB but not to the types breaks at runtime; a column in types but not in the DB silently returns `undefined` and surprises consumers.

## What to check

1. **Idempotency.** Every migration file should be safe to run twice. Walk `backend/migrations/*.sql` and confirm:
   - `CREATE TABLE` uses `IF NOT EXISTS`
   - `CREATE INDEX` uses `IF NOT EXISTS`
   - `ALTER TABLE … ADD COLUMN` uses `IF NOT EXISTS`
   - `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS … ON …`, OR the file is structured so re-application is harmless (the existing pattern is mostly DROP + CREATE)
   - `CREATE FUNCTION` uses `OR REPLACE`
   - `INSERT` into seed-style data uses `ON CONFLICT DO NOTHING` (or equivalent)

   Look at the recent migration `033_runs_environment.sql` for the canonical "additive change" shape: `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.

2. **RLS-on-every-tenant-table.** For every `CREATE TABLE foo (...)` with an `org_id` column, confirm `ALTER TABLE foo ENABLE ROW LEVEL SECURITY` and at least one `CREATE POLICY` on that table exist somewhere (not necessarily in the same file). Cross-reference with `audit/multi-tenant`; this audit can flag if a brand-new migration adds a tenant table with no policy.

3. **Migration ordering.** Filenames are `NNN_description.sql`. Confirm:
   - The numbers are gap-free (or that gaps are documented in a comment)
   - No two files share a number prefix
   - Recent additions referenced in PRs / docs match what's on disk (e.g. migration 030 is `tests_pending_unique`; migration 033 is `runs_environment` — these two are referenced in code comments)

4. **Type-drift backend.** Open `backend/src/types.ts` (`NormalizedRun`, `NormalizedSpec`, `NormalizedTest`) and the `Run` / `Spec` / `Test` shapes implied by `backend/src/routes/runs.ts` and `routes/uploads.ts`. Cross-reference against the `runs` / `specs` / `tests` columns in `001_initial.sql` plus all later `ADD COLUMN` migrations. Each schema column should either be in the type or be deliberately omitted (e.g. `org_id` is a tenant-scope key, not a public field). Recently added: `runs.environment` (migration 033) — confirm it's on `NormalizedRun.meta.environment`.

5. **Type-drift frontend.** Open `frontend/src/lib/api.ts`. Compare the `Run` / `RunDetail` / `Spec` / `TestResult` / `TestDetail` interfaces against the same DB columns. Mismatches:
   - Field on the type but no column → frontend reads `undefined`, often without erroring
   - Column in the DB but not on the type → field silently dropped from typed access (still accessible as `(row as any).x`)
   - Field renamed in DB but not the type — find by name diff

   Recently added: `Run.environment?: string` should match `runs.environment text not null default ''`.

6. **`*Detail` vs `*` shapes.** GET `/runs/:id` returns more fields than the GET `/runs` list (specs, tests, prev_id/next_id). Confirm `RunDetail extends Run` rather than redefining shared fields, and that the extra fields actually exist in the route's SELECT.

7. **Enum / CHECK drift.** `tests.status CHECK (status IN ('passed','failed','skipped','pending'))` — the same union should appear in both `backend/src/types.ts` and `frontend/src/lib/api.ts`. Add or change a status value? Three places update.

## Report

- **High** — non-idempotent migration (will fail on re-apply); table without RLS; type-drift that causes a runtime mismatch a user would hit.
- **Medium** — column added without a corresponding type field (silent type narrowing); migration that depends on a previous migration's seed data without checking.
- **Low** — number gap in migration filenames without a comment explaining; missing `IF NOT EXISTS` on a `CREATE INDEX` that happens to work because of upstream `DROP INDEX`.

For each: the migration filename + the columns/types diff + the file that needs the matching update.

## Useful starting points

- `backend/migrations/` — every `.sql` file in chronological order
- `backend/migrate.sh` — the application order
- `backend/src/types.ts`
- `frontend/src/lib/api.ts`
- `docker-compose.yml` — confirms the `docker-entrypoint-initdb.d` mount

## Delegate to

Use the `flakey-auditor` agent: `"Audit migration idempotency, RLS coverage, and type-drift between schema and TypeScript types."` Read-only.
