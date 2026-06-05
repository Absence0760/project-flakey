---
description: Audit Postgres schema design — normalization, constraints, referential integrity, naming/readability, and modern best practices across backend/migrations
---

Audit the cumulative schema defined by `backend/migrations/*.sql` for design quality: does the model make sense, is it internally consistent, is it readable, and does it follow current Postgres best practices — or is something badly stitched together?

## Goal

The migrations are the schema's source of truth (there is no separate `schema.sql` — the live shape is the sum of all `NNN_*.sql` files applied in order). Over 40+ migrations, design drift accumulates: a column added as `TEXT` in one migration that should have been an enum, an implicit foreign key that was never declared `REFERENCES`, a JSON blob that grew into something that should be relational, two tables that solve the same problem differently. This audit reads the *whole* schema as one artifact and judges it as a database designer would — separately from the idempotency / RLS / type-drift mechanics that `/audit/migrations` and `/audit/multi-tenant` already cover. **Do not re-report RLS gaps or idempotency here** — cross-reference and move on.

## What to check

1. **Referential integrity — every relationship is a real FK.** For every column whose name implies a relationship (`*_id`, `run_id`, `spec_id`, `org_id`, `user_id`, `release_id`, …), confirm a `REFERENCES other(col)` exists. `specs.run_id` and `tests.spec_id` are declared with `ON DELETE CASCADE` in `001_initial.sql` — that's the bar. Flag any `*_id` column that is an *implicit* reference (no FK), and any FK with no explicit `ON DELETE` action (the default `NO ACTION` is often not what the code assumes — e.g. a child that should cascade but doesn't, leaving orphans on parent delete).

2. **Constraint discipline.** For each table, judge whether the constraints encode the real invariants:
   - **NOT NULL** — columns the app always sets should be `NOT NULL` (with a default where sensible). Nullable columns that are never null in practice are a readability lie.
   - **CHECK** — `tests.status CHECK (status IN ('passed','failed','skipped','pending'))` is the canonical example. Look for *other* stringly-typed status/type/kind columns that have no CHECK and could hold garbage (e.g. `runs.reporter`, error-group statuses, release statuses, webhook platforms).
   - **UNIQUE** — natural keys that should be unique but aren't (and conversely, uniqueness enforced in app code that belongs in a constraint). Note the deliberate ones already added later (`runs.ci_run_id` uniqueness in 035, `specs`/`tests` uniqueness fences in 030/039).
   - **DEFAULT** — defaults that contradict NOT NULL, or `DEFAULT now()` on both `started_at` and `created_at` where one should be caller-supplied.

3. **Data-type appropriateness (modern Postgres).** Flag:
   - `SERIAL` for new PKs — modern Postgres (10+) prefers `GENERATED ALWAYS AS IDENTITY`. The existing tables use `SERIAL`; note it as a consistency baseline, but flag if *new* migrations mix `IDENTITY` and `SERIAL`.
   - `TIMESTAMP` (no tz) anywhere — should be `TIMESTAMPTZ` (the initial tables correctly use `TIMESTAMPTZ`; flag any later `TIMESTAMP` as drift).
   - `TEXT` vs `VARCHAR(n)` — `TEXT` is the right default; flag arbitrary `VARCHAR(255)` cargo-culting.
   - `json` instead of `jsonb`; `int` for something that should be `bigint` (counts/IDs that can grow); money/duration stored as `float`.
   - Arrays like `tests.screenshot_paths TEXT[]` — judge whether the array is the right call vs a child table (arrays are fine for small, owned, unordered-ish lists; flag if the array is being queried/joined into).

4. **Normalization vs. deliberate denormalization.** `runs` carries `total/passed/failed/skipped/pending/duration_ms` and `specs` carries the same aggregates — these are denormalized rollups of the child `tests`. Denormalization is a legitimate read-optimization, but it must be *maintained consistently*. Flag: aggregate columns with no clear single writer; places where the rollup and the source-of-truth child rows could silently diverge; denormalized copies of data that has its own table (a name/label duplicated instead of joined). Conversely, flag genuine normalization gaps — repeating groups, multi-value columns, comma-joined strings.

5. **"Stitched-together" smells.** Look for signs that the schema grew by accretion rather than design:
   - Two tables that model the same concept differently (e.g. parallel notes/links/status tables that could be one).
   - A `metadata`/`extra`/`data` JSON column that has accumulated keys the app now depends on — candidates for promotion to real columns.
   - Tenant scoping that's inconsistent across tables: some tables carry `org_id` directly, others scope only via a parent (`specs`/`tests` reach the tenant through `runs`). Confirm the indirect ones are *intentional* and that every query path can still resolve the tenant — flag tables where the scoping strategy looks accidental.
   - Boolean flags that should be a status enum, or several mutually-exclusive booleans on one row.
   - Columns added in a late migration that duplicate or shadow an earlier column.

6. **Naming & readability.** The schema should read cleanly:
   - Consistent `snake_case`; consistent table pluralization (`runs`, `specs`, `tests` are plural — flag singular outliers).
   - Index names follow `idx_<table>_<cols>` (see `001_initial.sql` / `020_performance_indexes.sql`); constraint/policy names are descriptive.
   - Column names mean the same thing everywhere (`created_at` vs `inserted_at` vs `ts`; `*_id` always an FK, never a free string id).
   - Comments (`COMMENT ON`) or migration-header comments explain non-obvious columns. A column whose purpose isn't clear from its name and has no comment is a finding.

7. **Lifecycle & temporal columns.** Tables that represent mutable entities should have `created_at` *and* `updated_at` (with a trigger or app-side discipline). Flag mutable tables missing `updated_at`, and soft-delete columns (`deleted_at`/`is_deleted`) applied inconsistently across tables that need the same treatment.

8. **Modern best-practice sweep.** Note (don't over-flag) opportunities the current schema predates: `GENERATED ALWAYS AS (...) STORED` columns for derived values currently computed in queries; native `ENUM` types or lookup tables for the stringly-typed status columns; partial-unique indexes for "one active X per Y" rules (031 already does this for sessions — is the pattern applied everywhere it's needed?); `CHECK` constraints for value ranges (counts ≥ 0, `passed + failed + skipped + pending ≤ total`).

## Report

Group by severity:

- **High** — a missing FK that allows orphaned/dangling rows the app assumes can't exist; a stringly-typed column with no CHECK that the app treats as an enum (garbage-in risk); a denormalized rollup with no consistent writer (silent divergence); an FK whose `ON DELETE` contradicts how the code deletes parents.
- **Medium** — a JSON blob that should be promoted to columns; inconsistent tenant-scoping strategy; missing `NOT NULL`/`UNIQUE` on a column the code relies on; a `TIMESTAMP`-without-tz or `json`-not-`jsonb` drift.
- **Low** — naming inconsistency; missing `updated_at` on a mutable table; `SERIAL`/`IDENTITY` mix; missing `COMMENT ON` for a non-obvious column; modern-feature opportunities (generated columns, enum types).

For each: the table + column, the migration file:line that introduced it, what's wrong, and the smallest forward migration that would fix it (this schema only moves forward — fixes are new `NNN_*.sql`, never edits to applied migrations).

## Useful starting points

- `backend/migrations/001_initial.sql` — the `runs` / `specs` / `tests` core (FKs, CHECK, denormalized counts, arrays)
- `backend/migrations/004_multi_tenancy.sql` — where `org_id` enters
- `backend/migrations/020_performance_indexes.sql` — index-naming baseline
- `backend/migrations/030`–`039` — the uniqueness fences and `WITH CHECK` tightening (constraint-discipline exemplars)
- the full `backend/migrations/*.sql` set read in order — the schema *is* the sum of these
- `docs/architecture.md` — the schema reference / data model narrative; flag where it and the SQL disagree
- `backend/src/types.ts` — how the app *thinks* the rows are shaped (a mismatch with the constraints is a design smell even when types technically compile)

## Delegate to

Use the `flakey-auditor` agent: `"Audit Postgres schema design — normalization, constraints, referential integrity, naming, and modern best practices across backend/migrations. Write the report to reviews/schema-design.md."` Read-only on the codebase — the deliverable is the findings report at **`reviews/schema-design.md`** (plus suggested forward-migration fixes), not applied changes.
