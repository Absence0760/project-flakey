---
description: Audit Postgres indexing and query patterns — missing / redundant / unused indexes, composite-column ordering, and slow query shapes in the routes
---

Audit the schema's indexes (in `backend/migrations/*.sql`) and the queries that hit them (in `backend/src/routes/*.ts` and `backend/src/db.ts`) for optimization: is every hot path indexed, are there redundant or never-used indexes, and are any query shapes destined to table-scan as the data grows?

## Goal

This is a flaky-test *dashboard* — read-heavy, with list/filter/sort pages over `runs`, `specs`, `tests`, `releases`, and the flaky/error aggregations. Good index coverage is the difference between a snappy `/runs` page and a sequential scan over every test result the org has ever uploaded. This audit is about *performance*, distinct from `/audit/schema-design` (correctness/readability) and `/audit/migrations` (idempotency). Keep them separate: a missing FK is a design finding; a missing *index on* that FK is a performance finding.

## What to check

### Indexing (static — read the migrations)

1. **Every foreign key has a supporting index.** Postgres does **not** auto-create an index on the referencing side of a FK — only on the referenced PK. Unindexed FKs make `ON DELETE CASCADE` and joins scan. `001_initial.sql` correctly adds `idx_specs_run_id` and `idx_tests_spec_id`. Walk every `*_id REFERENCES ...` column across all migrations and confirm a matching index exists (single-column or as the leading column of a composite). Flag each unindexed FK — call out the cascade-delete and join cost.

2. **Redundant / overlapping indexes.** A single-column index is redundant when a composite index leads with the same column. Concretely: `idx_runs_suite ON runs(suite_name)` (001) overlaps the leading column of `idx_runs_suite_org_id ON runs(suite_name, org_id, id DESC)` (020) — the single-column one may be dead weight (it still serves pure `suite_name` lookups, but verify the access pattern justifies keeping both). Find every such pair; flag the narrower one for removal unless a query needs exactly it. Duplicate indexes (same columns, same order) are always a finding.

3. **Composite-index column ordering.** For each composite index, confirm the column order matches the query: equality predicates first, then the range / sort column last. `idx_runs_org_created ON runs(org_id, created_at DESC)` is textbook for "this org's runs, newest first." Flag composites whose leading column isn't the one queries filter on by equality, and composites that could serve more queries with a column-order tweak.

4. **Partial & expression indexes for sparse predicates.** `idx_tests_failed_error ON tests(spec_id) WHERE status='failed' AND error_message IS NOT NULL` (020) is the model — it indexes only the rows the error views actually read. Look for other always-filtered predicates that scan a full index today: `status='failed'` lists, `aborted=true`, quarantined tests, non-default error-group statuses, "active" sessions. Flag full indexes that a partial index would shrink dramatically.

5. **JSONB / array access.** Any `jsonb` column that gets filtered (`->>`, `@>`, `?`) needs a GIN index; flag filtered jsonb with none. For `TEXT[]` columns like `tests.screenshot_paths`, flag any containment query (`= ANY`, `@>`) with no GIN backing.

6. **Index hygiene.** Flag: indexes on tiny lookup/enum tables (cost > benefit); over-indexing a write-hot table (every index is write amplification on `tests`, the highest-volume table); indexes that duplicate a UNIQUE constraint's implicit index.

### Query shapes (static — read the routes)

7. **N+1 and per-row queries.** Grep `backend/src/routes/*.ts` for queries issued inside a `.map`/`for`/`await Promise.all(items.map(...))` over a result set — a list endpoint that fetches children one row at a time. Flag with the route + the join/`IN`/`json_agg` that would collapse it to one query.

8. **`SELECT *` over wide / high-volume tables.** Flag `SELECT *` on `tests`/`specs` in list paths (drags `error_stack`, large text) where the route only needs a few columns. Detail endpoints pulling everything are fine.

9. **Pagination strategy.** Find `LIMIT … OFFSET …`. Large `OFFSET` scans and discards every skipped row — it degrades linearly on deep pages. The product already does *client-side* pagination at 50 on some pages (`/flaky`, `/releases`) by fetching a capped set; flag any server-side `OFFSET` on a table that can grow unbounded (`runs`, `tests`) and recommend keyset/seek pagination (`WHERE id < $cursor ORDER BY id DESC LIMIT n`).

10. **Unbounded scans & aggregates.** Flag `SELECT … FROM tests`/`runs` with no `LIMIT` and no indexed `WHERE`; `COUNT(*)` over a growing table on a hot path (consider an estimate or a maintained counter); `ORDER BY` on an unindexed column; the flaky/error `GROUP BY ... HAVING` aggregations (`backend/src/routes/flaky.ts`) — confirm the `recent_runs` window + the group keys are index-supported, since that query already sits near a performance/pagination boundary (see the `/flaky` window behavior).

11. **`tenantQuery` and the pool.** Every tenant query runs inside `tenantQuery`/`tenantTransaction` (`backend/src/db.ts`) which wraps a `set_config` + statement in a transaction. Confirm: the pool isn't being exhausted by long-held transactions; no query holds a connection across an `await` to an external service; the RLS predicate (`org_id = current_setting(...)`) is itself indexed (it almost always should be the leading column of the table's main composite — tie back to #3).

### Optional — live database (if one is running)

12. If `pnpm db:up` + seed is available, the auditor *may* (read-only) connect and use the catalogs for ground truth:
    - `pg_indexes` — list actual indexes per table (catch drift between migrations and reality).
    - Redundant-index and unindexed-FK detection via `pg_index` / `pg_constraint`.
    - `pg_stat_user_indexes.idx_scan = 0` — never-used indexes (only meaningful after representative traffic, e.g. an e2e run; note the caveat in the report).
    - `EXPLAIN (ANALYZE, BUFFERS)` on the `/runs` list query, the `/flaky` aggregation, and a deep-`OFFSET` page to confirm index usage vs. `Seq Scan`.
    Treat live findings as confirmation of the static ones; don't block the audit on a DB being up.

## Report

Group by severity:

- **High** — an unindexed FK on a high-volume table (`tests.spec_id`-class) feeding a hot join or cascade; a hot list/sort path doing a `Seq Scan`; server-side deep `OFFSET` on an unbounded table; an N+1 on a list endpoint.
- **Medium** — redundant/overlapping index pair (write-amplification + storage); a sparse-predicate full index a partial would shrink; `SELECT *` pulling large columns into a list; filtered `jsonb` with no GIN.
- **Low** — index on a tiny table; missing-but-low-traffic index; micro-ordering improvement on a composite; `COUNT(*)` on a hot path that's currently small.

For each: the table/index or route file:line, the query shape it affects, the expected behavior as data grows, and the fix (new `CREATE INDEX [CONCURRENTLY] IF NOT EXISTS …` forward migration, or the query rewrite). Note when an index build should be `CONCURRENTLY` (online, non-locking — `020_performance_indexes.sql` uses it; remember `CONCURRENTLY` can't run inside a transaction block, which interacts with `migrate.sh`).

## Useful starting points

- `backend/migrations/001_initial.sql` — base indexes (`idx_specs_run_id`, `idx_tests_spec_id`, `idx_runs_suite`, `idx_runs_branch`)
- `backend/migrations/020_performance_indexes.sql` — composite + partial index exemplars and the `CONCURRENTLY` pattern
- `backend/src/routes/runs.ts`, `routes/flaky.ts`, `routes/tests.ts`, `routes/releases.ts` — the hot read paths and their `WHERE`/`ORDER BY`/`GROUP BY`
- `backend/src/db.ts` — `tenantQuery` / `tenantTransaction` and the connection pool config
- `docs/architecture.md` — schema + endpoint list (which routes are read-hot)

## Delegate to

Use the `flakey-auditor` agent: `"Audit Postgres indexing and query patterns — missing / redundant / unused indexes, composite ordering, and slow query shapes across backend/migrations and the routes. Write the report to reviews/db-performance.md."` Read-only on the codebase — the deliverable is the findings report at **`reviews/db-performance.md`** (plus suggested index/forward-migration and query rewrites), not applied changes.
