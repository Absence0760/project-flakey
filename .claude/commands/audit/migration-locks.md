---
description: Audit production-safety of DDL in backend/migrations — which migrations take blocking locks or rewrite tables and would cause downtime against a populated prod RDS
---

Audit `backend/migrations/*.sql` for online-DDL safety: classify every statement by the Postgres lock it takes and the work it does, and flag the ones that would block writes (or rewrite a table) when applied to the live, populated RDS instance — not the empty local DB where everything is instant.

## Goal

Migrations run on a fresh, tiny local DB in dev and on the seeded e2e DB — both small enough that a table rewrite or an `ACCESS EXCLUSIVE` lock is invisible. Against prod, `tests` (the highest-volume table) and `runs` are large, and `backend/migrate.sh` applies the whole `migrations/` set on container boot (`for f in "$DIR"/*.sql; … psql -f "$f"`). A migration that takes an `ACCESS EXCLUSIVE` lock or rewrites a table there will block every reader and writer for the duration — that's downtime, and on a rolling ECS deploy it can wedge the new task while the old one is still serving. This audit reads the migrations as a DBA would before a prod apply, judging *lock impact and online-safety*, and nothing else.

This is distinct from `/audit/migrations` (idempotency, RLS coverage, type-drift) and `/audit/db-performance` (whether the right indexes exist at all). **Do not re-report**: missing `IF NOT EXISTS`, RLS gaps, type-sync drift between `types.ts`/`api.ts`/schema (that's `/audit/migrations`); nor whether an index *should* exist or its column ordering (that's `/audit/db-performance`). Here the question is narrower: given that this DDL runs, *what does it lock and for how long against a big table*.

## What to check

Read every `backend/migrations/*.sql` in order and classify each DDL statement by lock impact. The specific patterns:

1. **`ADD COLUMN` with a default — constant vs. volatile.** PG11+ adds a column with a *constant* default as a metadata-only change (no rewrite, brief `ACCESS EXCLUSIVE`). `010_webhook_platform.sql` (`ADD COLUMN … platform TEXT NOT NULL DEFAULT 'generic'`) and `036_account_lockout.sql` (`ADD COLUMN … failed_login_attempts INT NOT NULL DEFAULT 0`) and `033_runs_environment.sql` (`ADD COLUMN … environment TEXT NOT NULL DEFAULT ''`) all hit the fast path — note them as the safe baseline. Flag any `ADD COLUMN` whose default is *volatile* (`DEFAULT now()`, `DEFAULT gen_random_uuid()`, a function call, a subquery) — those force a full table rewrite under `ACCESS EXCLUSIVE`. `DEFAULT NOW()` on a column in a brand-new `CREATE TABLE` is fine (no existing rows); only an `ALTER TABLE … ADD COLUMN … DEFAULT now()` against a populated table rewrites.

2. **The add-column / backfill / `SET NOT NULL` sequence.** `004_multi_tenancy.sql` is the canonical multi-step pattern: `ADD COLUMN org_id INT REFERENCES …` (nullable, fast) → `UPDATE runs SET org_id = …` (a single unbatched backfill over the whole table) → `ALTER TABLE runs ALTER COLUMN org_id SET NOT NULL` (a full sequential scan under `ACCESS EXCLUSIVE` to verify no nulls). On a large `runs`/`tests`, both the unbatched `UPDATE` and the `SET NOT NULL` scan block. Flag every `SET NOT NULL` on an existing big table, and recommend the online form: add a `NOT VALID CHECK (col IS NOT NULL)`, `VALIDATE` it (a weaker `SHARE UPDATE EXCLUSIVE` lock), then `SET NOT NULL` (PG12+ can then skip the scan by trusting the validated constraint).

3. **`ALTER COLUMN … TYPE`.** A type change rewrites the entire table and rebuilds every dependent index under `ACCESS EXCLUSIVE`. Confirm whether any migration changes a column type (none obvious today — `042_normalize_int_cast.sql` only swaps RLS *policy* expressions, no table touched, so it is metadata-only and safe). Flag any real `ALTER COLUMN … TYPE` against a populated table as High; recommend the add-new-column + backfill-in-batches + swap approach.

4. **`ADD CONSTRAINT` / `ADD FOREIGN KEY` without `NOT VALID`.** Adding a CHECK or FK constraint in one step holds a strong lock (`SHARE ROW EXCLUSIVE` on the table, `ACCESS EXCLUSIVE`-class blocking of writes) while it scans every existing row to validate. The online form is two steps: `ADD CONSTRAINT … NOT VALID` (instant, validates only new rows) then `VALIDATE CONSTRAINT` (scans under the weaker `SHARE UPDATE EXCLUSIVE`, lets writes through). Flag any single-step `ADD CONSTRAINT`/`ADD FOREIGN KEY`/`ADD … CHECK` against a populated table. (FK columns added inline in `CREATE TABLE` are fine — empty table.)

5. **`CREATE INDEX` vs `CREATE INDEX CONCURRENTLY`.** A plain `CREATE INDEX` takes `ACCESS EXCLUSIVE` for the whole build — blocks all writes to the table while it scans. `020_performance_indexes.sql` correctly uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (builds under a weaker `SHARE UPDATE EXCLUSIVE`, two passes, writes continue) — that's the bar for any index on `runs`/`tests`/`specs`. Flag every plain `CREATE [UNIQUE] INDEX` on a large table. Note the live-path uniqueness indexes in `030_tests_pending_unique.sql` (`uniq_specs_run_file`, `idx_tests_pending_unique`) and `035_runs_ci_run_unique.sql` (`uniq_runs_ci_run`) are *not* `CONCURRENTLY` — on a populated `tests`/`runs` these block writes for the build, and a `CREATE UNIQUE INDEX` additionally blocks while it checks for existing duplicate keys.

6. **Long-running data backfill inside a migration.** `030_tests_pending_unique.sql` runs heavy DML before the index build: a multi-CTE `UPDATE tests … FROM dupes` reassigning orphaned rows, then two cascading `DELETE FROM specs`/`DELETE FROM tests` dedupe passes. `004` and `021_default_retention.sql` (`UPDATE organizations SET retention_days = 7 WHERE retention_days IS NULL`) backfill in a single statement. On a big table a single unbounded `UPDATE`/`DELETE` takes row locks on every touched row, bloats the table, and holds those locks for the whole statement. Flag unbatched whole-table DML and recommend batching (`… WHERE id BETWEEN $lo AND $hi`, looped) for anything that would touch a large `tests`/`runs`. (`021` touches `organizations`, which is small — note it as low/no concern.)

7. **`CONCURRENTLY` cannot run inside a transaction block.** `CREATE INDEX CONCURRENTLY` (and `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`) error if executed inside an explicit `BEGIN … COMMIT` or any wrapping transaction. Confirm how `migrate.sh` invokes each file: it runs `psql -f "$f" --set ON_ERROR_STOP=1` per file with **no** wrapping `BEGIN`, so each statement in a multi-statement file is its own implicit transaction — `020`'s `CONCURRENTLY` statements work. Flag two failure modes: (a) any migration file that wraps statements in an explicit `BEGIN;`/`COMMIT;` *and* contains a `CONCURRENTLY` (it will error at apply time); (b) any `CONCURRENTLY` index build that fails partway and leaves an `INVALID` index behind — note that `IF NOT EXISTS` will then *not* rebuild it, so a failed concurrent build needs a manual `DROP INDEX` + retry, and call out which migrations are exposed to that.

8. **Lock ordering / multiple objects in one file.** A migration that takes strong locks on several tables in sequence (e.g. `004` touches `runs`, `api_keys`, `specs`, `tests`) widens the blocking window and the deadlock surface against concurrent app traffic. Note files that serialize several `ACCESS EXCLUSIVE` operations and would benefit from being split or run in a maintenance window.

## Report

Group by severity. Tiers for *this* audit are about blast radius against a populated prod table, not correctness:

- **High** — a statement that rewrites a table or holds `ACCESS EXCLUSIVE` on a large table (`tests`, `runs`, `specs`) and would block prod readers/writers for the apply: an `ALTER COLUMN … TYPE`, an `ADD COLUMN` with a volatile default, a `SET NOT NULL` scan, a single-step `ADD CONSTRAINT`/FK validate, a plain (non-`CONCURRENTLY`) index build on a big table, or an unbatched whole-table `UPDATE`/`DELETE`.
- **Medium** — a strong lock that is real but brief or on a smaller/bounded table, and is avoidable with the online form (e.g. a `CREATE UNIQUE INDEX` on a moderate table, a backfill that should be batched but touches a bounded set). Also the `CONCURRENTLY`-inside-a-txn hazard and the failed-concurrent-build / `INVALID` index footgun.
- **Low** — style and could-be-better: a plain `CREATE INDEX` on a table that is and will stay small; a multi-object migration that *could* be split for a tighter lock window; using `CONCURRENTLY` everywhere as a default even where the table is tiny.

For each finding: the migration `file:line`, the exact statement, the lock it takes and against which table, what happens when it runs against a populated prod table, and the **safe rewrite** (the concrete forward migration — `NOT VALID` then `VALIDATE`; `CONCURRENTLY` outside a txn; batched backfill loop; add-column-then-swap for a type change). This schema only moves forward — fixes are new `NNN_*.sql`, never edits to applied files; for an already-shipped risky migration, the deliverable is the safe *procedure* to apply it (maintenance window, manual `CONCURRENTLY` step) rather than a code edit.

## Useful starting points

- `backend/migrations/004_multi_tenancy.sql` — the add-column / backfill / `SET NOT NULL` sequence (the canonical multi-step lock pattern)
- `backend/migrations/020_performance_indexes.sql` — the `CREATE INDEX CONCURRENTLY` exemplar (the bar for big-table indexes)
- `backend/migrations/030_tests_pending_unique.sql` — heavy multi-statement backfill (`UPDATE`/`DELETE`) + non-concurrent unique index builds on `tests`/`specs`
- `backend/migrations/035_runs_ci_run_unique.sql` — non-concurrent `CREATE UNIQUE INDEX` on `runs`
- `backend/migrations/010_webhook_platform.sql`, `036_account_lockout.sql`, `033_runs_environment.sql` — `ADD COLUMN … NOT NULL DEFAULT <const>` fast-path baseline
- `backend/migrations/042_normalize_int_cast.sql`, `021_default_retention.sql` — metadata-only / small-table changes (the safe baseline to contrast against)
- `backend/migrate.sh` — the apply harness: per-file `psql -f … --set ON_ERROR_STOP=1`, no wrapping transaction (the constraint that decides whether `CONCURRENTLY` is legal)

## Delegate to

Use the `flakey-auditor` agent: `"Audit migration lock impact and online-DDL safety across backend/migrations — classify each statement by Postgres lock and table-rewrite cost against a populated prod table, and flag anything that would block prod. Write the report to reviews/migration-locks.md."` Read-only on the codebase — the deliverable is the findings report at **`reviews/migration-locks.md`** (with the safe-rewrite per finding), not applied changes. Cross-reference `/safe-migration` and the `migration-coordinator` agent for actually landing or applying any of the recommended fixes.
