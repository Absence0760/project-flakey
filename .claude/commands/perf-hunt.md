---
description: Hunt for real performance problems — N+1 queries, missing/unused indexes, O(n²) loops, per-event recompute storms, oversized payloads, render thrash — measure each before and after, fix the root cause, and guard with a test where it fits. Commits scoped; never pushes.
argument-hint: "[optional scope — a route, query, layer, or page, e.g. 'GET /runs', the live ingestion path, the runs list; omit to profile the hot paths]"
---

Find performance problems that **actually bite at realistic scale** and fix them at the root. The discipline that separates this from premature optimization: **measure before you touch anything, and measure again after** — a fix with no before/after number is a guess, not a perf fix. This is the actionable, fix-and-land counterpart to the read-only `/audit/db-performance` sweep.

`$ARGUMENTS` is an optional scope (a route, query, layer, or page). If empty, profile the hot paths (step 1).

## Operating rules (non-negotiable — root `CLAUDE.md` guard rails)

- **Measure first, measure after.** Quantify the cost before changing anything (`EXPLAIN (ANALYZE, BUFFERS)` for SQL, row-count-scaled timing for loops, payload bytes, Playwright trace / `performance` marks for the frontend) and report the before→after delta. No measurement, no claim.
- **Correctness is not negotiable for speed.** A faster path must return identical results and preserve every invariant — especially RLS/tenancy. Never drop a `tenantQuery` for a bare `pool.query` to save a hop, never widen a query past its org scope, never cache across tenants. (Rails 5, 11.)
- **Fix the root cause, not the symptom.** Add the missing index / batch the N+1 / hoist the invariant work out of the loop — don't paper over a slow path with a cache that then needs invalidation, unless caching genuinely is the right answer (and then invalidation is part of the fix).
- **Prove the scale matters.** A microsecond on a 10-row dev table is noise. Reason about (or seed) realistic row counts; state the n at which the problem bites. Skip changes that only help at sizes the product never reaches.
- **Docs-as-code; commit scoped; never push.** A new index ships in a migration (`/safe-migration` discipline — `IF NOT EXISTS`, RLS unaffected, type-sync N/A); doc any changed perf-relevant convention. Fix and any test as separate path-scoped commits. (Rails 12; git workflow.)

## Where the cost has actually lived here

- **N+1 in route handlers.** A list endpoint that loops and fires a per-row query (or a per-row subquery that re-scans). Look for correlated subqueries in `SELECT` lists and `for (const row …) await query(…)`.
- **Per-event recompute storms.** The live path recomputes spec+run stats on every single test event with `SELECT COUNT(*)` over all sibling rows — O(n²) over a run's tests. Quantify at a realistic test count before deciding it's worth batching/deferring.
- **Missing, redundant, or unused indexes.** A `WHERE`/`JOIN`/`ORDER BY` column with no supporting index (seq scan at scale); a composite index with the wrong column order; duplicate indexes; indexes nothing queries. (`/audit/db-performance` enumerates the catalog — reuse its findings.)
- **Oversized payloads.** An endpoint returning unbounded rows or fat columns (full `command_log`, `duration_history`, screenshots) the caller doesn't need; a list that ships detail-level data. Cap, paginate, or project.
- **Frontend render thrash.** A `$derived`/`$effect` recomputing a big sort/filter on every keystroke; an un-keyed `{#each}` re-rendering a long list; client-side filtering of a server-paginated set that silently hides rows (a correctness *and* perf smell).
- **Repeated invariant work in a loop** — recompiling a regex, re-parsing, re-fetching config per iteration instead of once.

## Procedure

1. **Pick + measure the target.** If `$ARGUMENTS` is given, profile it. If empty, rank the hot paths (upload/ingest, `GET /runs`, run detail, dashboard stats, flaky compute, live events) by call frequency × data volume. For the top pick, capture a **baseline number** the way that path is actually exercised: `EXPLAIN (ANALYZE, BUFFERS)` against a realistically-sized table (seed more rows if dev is too small to show the problem), a timed loop at scale, payload byte size, or a Playwright trace. Report it.
2. **Find the root cause.** Map the query plan / the loop's complexity / the payload shape. Confirm it's the actual bottleneck, not an assumption — the slow line is rarely the one you'd guess.
3. **Fix at the root.** Add the index (in a migration), batch the N+1 into a single set-based query, hoist invariant work, project/paginate the payload, memoize the frontend derivation. Keep the result byte-for-byte identical (diff before/after output on the same input).
4. **Re-measure.** Same workload, same method. Report before→after (plan node, ms, bytes, rows scanned). If the delta is noise at realistic scale, **revert** — a non-improving change is not a fix.
5. **Guard it** where a test fits: a smoke test asserting the result is unchanged and (where meaningful) that the query issues one round-trip not N; a migration's index is covered by the schema. Don't write a flaky wall-clock assertion — assert the structural win (one query, bounded rows), not a raw millisecond threshold.
6. **Verify + review.** Type gate; new/nearby tests pass (report counts). Index migrations: apply locally and confirm via `/safe-migration` discipline. For anything touching tenancy or a gate signal, run `code-reviewer`.
7. **Commit** scoped (migration, fix, test as separate commits as applicable); **never push**.

## Report

```
## /perf-hunt — <scope>

**Target + baseline:** <path> — <how measured> → <before number (plan/ms/bytes/rows)>

**Problem:** <root cause: N+1 / seq scan / O(n²) / fat payload / render thrash> — bites at n ≈ <scale>

**Fix:** <index / batched query / hoist / paginate / memoize> — result identical (verified)

**After:** <same measurement → after number> | **delta:** <e.g. 1200ms → 40ms, seq scan → index scan, 30 queries → 1>

**Guard:** <test/migration that locks it — or "structural; covered by <x>">

**Verification:** <type gate; tests N/N; migration applied>

**Commits:** <hash + subject>

**Deferred / recommended:** <bigger wins out of scope, with the approach named — or "nothing outstanding">
```

## Tone

Numbers or it didn't happen. Lead with before→after. If the suspected hot path turned out fine at realistic scale, say so and move on — don't ship an optimization that doesn't move a measured number.
