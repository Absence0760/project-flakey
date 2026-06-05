---
description: Audit seed data for the class of e2e flakes it can cause — fixtures sitting on pagination boundaries, non-deterministic ordering, additive pollution, and worker-tenant asymmetry
---

Audit `backend/src/seed.ts` and the e2e specs that depend on it for *seed-induced* flakiness: fixtures parked on a pagination boundary, counts that "naturally exceed 50" but can dip below, sorts with no stable tiebreak, and worker-tenant playgrounds that aren't all the same shape. This is preventative — recent flakes traced back to seed fixtures sitting at fragile boundaries.

## Goal

The e2e suite runs Playwright workers in parallel, each pinned to its own worker-tenant (`acme-w{0..3}`, seeded by `populateOrg(...)` at `backend/src/seed.ts:1799`). Specs both *read* the seeded playground and *write* into it (create a release, upload a run), so the seed isn't a frozen snapshot — concurrent specs in the same worker-tenant move counts around mid-run. When a fixture is seeded right at a page-size boundary, one concurrent insert tips it onto page 2 and the assertion that expected it on page 1 flakes. This audit finds those fragile placements *before* they flake.

This is distinct from the adjacent audits — keep the lanes clean:
- **Not** test-quality lint (sleep/timeout/retry-mask) — that's the `## Fix bugs at the source` rule in the root `CLAUDE.md`; the persona/regression specs already enforce it. Here we only care about flakes whose *root cause is the seed*.
- **Not** index/query performance — `/audit/db-performance` owns the `/flaky` window and `OFFSET` mechanics. Reference the PAGE_SIZE=50 / 30-run-window numbers, don't re-audit the SQL.
- **Not** schema constraints or RLS — `/audit/schema-design` and `/audit/multi-tenant` own those. The `includeFixtures` gating on the global-unique API key / invite token (`seed.ts:1642`, `:1725`) is a *correctness* fence those audits cover; only flag it here if a worker tenant's playground diverges in a way that breaks spec parity.

## What to check

1. **Fixtures parked on the 50-item page boundary.** The UI paginates client-side at `PAGE_SIZE = 50` on `/releases`, `/flaky`, `/errors`, `/slowest`, `/manual-tests` (see `frontend/src/routes/(app)/releases/+page.svelte:148` and the shared `.load-more-btn` contract documented in `frontend/tests-e2e/cross-cutting/pagination.spec.ts:4-21`). The canonical live hazard: the **`v2.5.0` draft release seeds at rank ~50** and a single concurrent release insert bumps it to page 2 — `frontend/tests-e2e/releases/release-detail.spec.ts:26-30` already documents this and works around it with the search box. Walk every seeded "hero" fixture a spec asserts by name (`v2.3.0`/`v2.4.0`/`v2.5.0`, the `flaky-demo` row, the Gherkin demo run) and compute its approximate rank within its page's sort: how many bulk rows sort ahead of it? The bulk releases (`seed.ts:1338-1398`, ~52 rows) plus the 3 hero releases put `v2.5.0` right at the line. Flag any fixture whose rank lands in roughly **45–55** of its page.

2. **Counts that hover at 50 within a moving window.** `/flaky` candidates are computed over the **default 30-run window** (`backend/src/routes/flaky.ts:11`, `runs=30`, capped at 100). The seed comments openly admit the count "hovers right around the 50-item page size" and that concurrent uploads shift the window (`pagination.spec.ts:91-96`) — the spec pins `?window=100` to escape it. Audit the *seed side* of this: the `flakyTests` set (`seed.ts:261-306`, ~43 titles) × multi-suite assignment is what's expected to clear 50, but runs pick only 2–5 of ~12 specs at random (`seed.ts:580-581`) and statuses roll randomly (`seed.ts:627-634`). Flag any page whose Load-more assertion depends on a *randomized* count clearing 50 with no comfortable margin, and any seed comment claiming a page "naturally exceeds 50" that the RNG can drop below or leave empty.

3. **Randomness that can leave a page empty or below threshold.** The seed already hit this once and patched it: the "deterministic flaky-test guarantee" block (`seed.ts:727-793`) hand-crafts a 4-run alternating pass/fail `flaky-demo` because the random rolls *can* leave `/flaky` empty when no `(full_title, suite_name)` tuple lands both a pass and a fail in the window. Find every *other* page whose non-emptiness rests on RNG: `status = Math.random() < 0.4` flaky flips (`seed.ts:628`), the `roll < 0.1` failure rate for non-flaky tests (`seed.ts:631`) that feeds `/errors`, the `numSpecs = randomInt(2, 5)` spec selection. Flag where a page can render zero rows on an unlucky seed and recommend a deterministic floor like the `flaky-demo` block.

4. **Non-deterministic ordering — sorts with no stable tiebreak.** `/releases` sorts **client-side by `target_date`** (default `sortBy = 'target'`, `frontend/src/routes/(app)/releases/+page.svelte:35,124-130`) while the backend returns rows ordered by `created_at DESC` (`backend/src/routes/releases.ts:91,322`). The bulk releases share `target_date` values within a status band (`seed.ts:1363-1364`, `offsetDays = randomInt(...)` collisions are likely across 52 rows) and there's **no secondary sort key** — two releases with the same `target_date` can reorder between DB runs, shifting which page a boundary fixture lands on. Walk every list the seed feeds and flag sorts keyed on a non-unique column (`target_date`, `priority`, `created_at` truncated to a day) with no `id`/version tiebreak. Recommend adding a deterministic tiebreak on the sort, not loosening the assertion.

5. **Additive vs. truncating seed.** The seed *truncates* its core tables up front — `TRUNCATE runs, specs, tests RESTART IDENTITY CASCADE` and the `org_invites` truncate + `DELETE FROM` chain (`seed.ts:479-484`) — so a re-run of the whole script is clean. But confirm: (a) every table a spec asserts a *count* on is covered by that reset (e.g. `manual_tests`, `releases`, `release_checklist_items`, `audit_log`, `webhooks`, `quarantined_tests` are cascade-deleted via `runs`/`organizations`, or explicitly cleared — verify none survive a re-seed and double the fixtures); (b) the per-tenant `ON CONFLICT DO NOTHING` inserts (`ui_known_routes`, `manual_test_groups`, `release_runs`) are idempotent the way they claim. Flag any table that accumulates across re-runs and any spec that would see duplicated fixtures (e.g. "13 grouped tests" at `release-detail.spec.ts:84` doubling to 26).

6. **Worker-tenant parity.** Every worker tenant must carry the **same playground** as Acme so any Playwright shard can run any spec. `populateOrg(orgId, adminId, includeFixtures)` is invoked once for Acme with `true` (`seed.ts:1790`) and once per worker with `false` (`seed.ts:1826`). The *only* legitimate divergence is the two `includeFixtures`-gated global-unique fixtures (API key `seed.ts:1642`, invite token `seed.ts:1725`). Flag any *other* fixture that lives outside `populateOrg` (so Acme-only) but is asserted by a spec that can run on a worker tenant — that spec passes on shard 0 and flakes on shards 1–3. Confirm `E2E_WORKER_TENANTS` default (4, `seed.ts:1798`) matches the Playwright worker count and that no spec hard-codes a tenant slug.

7. **Specs asserting "page 1" without scoping.** The robust pattern is already in the tree: scope to the fixture via the page's search box before asserting (`release-detail.spec.ts:30`, `release-create-delete.spec.ts:47-48`, `release-deep-coverage.spec.ts:372-373` all `getByPlaceholder("Search version or name…").fill(...)`). Grep the e2e specs for the *anti-pattern*: a `getByRole`/`locator(".version")`/text assertion on a named seeded fixture that does **not** first filter or search, and so silently depends on that fixture being within the first 50 rendered rows. Flag each one with the search/filter scoping it's missing.

## Report

Group by severity. For this audit, severity is about *how close to flaking the seed already is*:

- **High** — an active flake risk: a fixture or count sitting in the ~45–55 boundary band on a paginated page that a concurrent spec in the same worker-tenant can flip (the `v2.5.0`-class hazard), where a spec asserts it on page 1 without search-scoping. These flake today under parallel load.
- **Medium** — non-deterministic ordering (sort on a non-unique key with no tiebreak), additive pollution that doubles a fixture on re-seed, or worker-tenant asymmetry (a fixture outside `populateOrg` asserted by a shardable spec). Not flaking yet, but a latent trap.
- **Low** — brittle-but-currently-safe margins: a count that clears 50 with comfortable headroom today but rests on RNG; a "naturally exceeds 50" comment that's true now but undocumented as load-bearing; a missing deterministic floor on a page that happens to always populate.

For each finding: the `seed.ts` line (or spec `file:line`) of the fixture, the page + its `PAGE_SIZE`/window, *why* it's fragile (which concurrent action or RNG roll tips it), and the fix. Prefer, in order: (1) a comfortable margin above the boundary (seed well clear of 50, e.g. the bulk-release count to ~70); (2) a deterministic sort tiebreak or a hand-crafted guaranteed fixture (the `flaky-demo` pattern); (3) test-side scoping via search/filter. **Never** recommend a flaky-tolerant assertion (loosened count, widened timeout, retry) — that violates the root `CLAUDE.md` source-of-truth rule.

## Useful starting points

- `backend/src/seed.ts` — the whole seed; key blocks: `populateOrg` (`:544`), `flakyTests` set (`:261`), deterministic `flaky-demo` (`:727`), bulk releases (`:1338`), bulk manual tests (`:1216`), bulk suites (`:1035`), worker-tenant loop (`:1799`)
- `backend/CLAUDE.md` — the `npm run seed` description (fixture inventory + worker-tenant contract)
- `frontend/tests-e2e/cross-cutting/pagination.spec.ts` — the PAGE_SIZE=50 / Load-more contract and the `?window=100` `/flaky` workaround
- `frontend/tests-e2e/releases/release-detail.spec.ts` — the `v2.5.0`-at-rank-~50 hazard and the search-box scoping pattern (`gotoRelease`)
- `frontend/tests-e2e/releases/` and `flaky/`, `slowest/`, `errors/`, `dashboard/` — specs that assert named seeded fixtures
- `frontend/src/routes/(app)/releases/+page.svelte` — `PAGE_SIZE`, `visibleCount`, and the `target_date` client-side sort with no tiebreak
- `backend/src/routes/flaky.ts` — the 30-run default window (`runs=30`, cap 100) the `/flaky` count rides on

## Delegate to

Use the `flakey-auditor` agent: `"Audit seed data for e2e-flake fragility — pagination boundaries, per-tenant determinism, additive pollution. Write the report to reviews/seed-integrity.md."` Read-only on the codebase — the deliverable is the findings report at **`reviews/seed-integrity.md`** (with seed/spec line refs and the recommended margin/tiebreak/scoping fix per finding), not applied changes.
