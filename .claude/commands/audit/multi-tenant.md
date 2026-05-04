---
description: Verify RLS is enabled on every table and that cross-org access is blocked at the DB layer
---

Audit Postgres Row-Level Security across every migration and confirm the application can't read/write across org boundaries.

## Goal

The backend connects as `flakey_app` (non-superuser) specifically so RLS policies apply. A single table without `ENABLE ROW LEVEL SECURITY` is a free cross-org read for any authenticated user — the application-side `tenantQuery` becomes optional rather than load-bearing. Find every gap in one pass.

## What to check

1. **RLS-on-every-tenant-table.** Walk `backend/migrations/*.sql`. For every `CREATE TABLE foo (...)` that has an `org_id` column (or is otherwise tenant-scoped), confirm a later — or the same — migration has `ALTER TABLE foo ENABLE ROW LEVEL SECURITY` and at least one `CREATE POLICY`. Tables without an `org_id` column may legitimately not have RLS (e.g. `users`, `organizations` itself), but flag if you can't immediately tell why.

2. **Policy strength.** For each `CREATE POLICY`, classify:
   - `org_id = current_setting('app.current_org_id')::int` — tenant-scoped (the canonical pattern)
   - membership-joined — checks `org_members` for the current user
   - public-read — no `org_id` predicate (rare; should be commented)
   - service-role-only — superuser bypass (legitimate for migrations / cron, but should not be how the app reads)

   Anything broader than "filter by current_setting" on a tenant table needs to be load-bearing for a documented reason.

3. **Missing `set_config` callsites.** The set_config that activates RLS lives only in `backend/src/db.ts` (`tenantQuery` + `tenantTransaction`). A route that does `pool.query` against a tenant table runs without `app.current_org_id` set — the policies see `current_setting('app.current_org_id', true)` returning `NULL` and (depending on the policy) either fail closed (good) or pass the comparison silently. Cross-reference findings here with `audit/auth` step 3.

4. **Cross-table joins in policies.** A policy like `USING (run_id IN (SELECT id FROM runs WHERE …))` only works if `runs` also has RLS that doesn't recurse infinitely or expose hidden rows. Walk every policy that references a non-self table and verify the chain.

5. **`SECURITY DEFINER` functions.** Grep `backend/migrations/` for `security definer`. For each, verify the function body either checks the resource owner OR is intentionally callable by anyone (e.g. `lookup_api_key()` — pre-tenant by design). Flag any DEFINER without a checking line.

6. **Cross-org reachability tests.** `backend/src/tests/phase_9_10.smoke.test.ts` and any other test files exercise some cross-org paths (look for the snapshot endpoint's "rejects foreign run" test). If you find a new tenant-scoped endpoint that lacks an equivalent foreign-run test, flag it as a coverage gap.

7. **`current_setting('app.current_org_id', true)` everywhere.** The `, true` argument makes it return NULL on missing setting instead of erroring. Search migrations for the bare form (no second arg) and confirm each is intentional — without `true`, the policy errors on connections that haven't gone through `tenantQuery`, which fail-closes but also breaks legitimate cross-org callers (background jobs).

## Report

Group findings by severity:

- **Critical** — a tenant table is missing `ENABLE ROW LEVEL SECURITY`; a policy lets one org read another's rows; a `SECURITY DEFINER` function bypasses tenant scoping without an owner check.
- **High** — a new tenant-scoped route uses `pool.query` instead of `tenantQuery`; a join-chain policy depends on a non-RLS table.
- **Medium** — overscoped policy that works today but breaks the principle of least privilege.
- **Low** — undocumented policy intent, missing comment on `SECURITY DEFINER`.

For each: file:line, the policy/function name, what's missing, the worst-case blast radius.

## Useful starting points

- `backend/migrations/` — every migration in chronological order
- `backend/migrations/001_initial.sql` — initial schema
- `backend/src/db.ts` — `tenantQuery` / `tenantTransaction`, the only callers that set `app.current_org_id`
- `backend/CLAUDE.md` — "Runs as DB user `flakey_app` (non-superuser) so RLS policies apply. Don't bypass this by connecting as a superuser."
- `docs/architecture.md` — schema reference + tenant model

## Delegate to

Use the `flakey-auditor` agent: `"Audit RLS coverage and cross-org reachability across the schema."` Read-only.
