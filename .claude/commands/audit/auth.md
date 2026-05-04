---
description: Sweep every Express route for `requireAuth` gating + `tenantQuery`/`tenantTransaction` discipline
---

Audit auth gating and tenant-context enforcement across the backend API.

## Goal

A single route registered without `requireAuth` exposes whatever it does to anonymous callers. A single route that does `pool.query` instead of `tenantQuery` reads across org boundaries — the RLS policies don't apply because `app.current_org_id` was never set on that connection. Find both classes of bug in one pass.

## What to check

1. **Global router registration.** `backend/src/index.ts` mounts every router via `app.use("/path", requireAuth, fooRouter)`. Public-by-design mounts:
   - `/health`
   - `/auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/resend-verification`, `/auth/verify-email` (the auth router itself routes some endpoints behind `requireAuth` internally)
   - `/badge` (public read for shields.io-style badges)

   Anything else mounted without `requireAuth` is a finding. Anything mounted with `requireAuth` but with internal `router.<verb>("/sub", ...)` handlers that the same router exposes via a public sibling needs re-checking — the middleware applies at the mount, not per-handler.

2. **`req.user!` non-null assertion.** Inside any route handler, `req.user!` is only safe when `requireAuth` actually ran. Grep `backend/src/routes/` for `req.user!` and confirm each lives in a router that's mounted behind `requireAuth` (or has a per-handler `requireAuth` wrapper).

3. **`tenantQuery` / `tenantTransaction` discipline.** Routes that read or write tenant data must use `tenantQuery(req.user!.orgId, sql, params)` or `tenantTransaction(req.user!.orgId, async (client) => { ... })`. The DB connects as `flakey_app` (non-superuser, RLS applies) — without the `set_config('app.current_org_id', …)` that those wrappers do, RLS sees no org context and policies fail closed (or worse, succeed-open if a policy is mis-written).

   **Existing legitimate `pool.query` callsites** (cross-org by design — don't flag):
   - `backend/src/auth.ts` — API key lookup before tenant context exists
   - `backend/src/routes/auth.ts` — login, registration, invite acceptance (pre-tenant)
   - `backend/src/integrations/*.ts` — background jobs that iterate every org
   - `backend/src/retention.ts`, `backend/src/scheduled-reports.ts` — cron sweeps across orgs
   - `backend/src/routes/badge.ts` — public badge endpoint (no auth, looks up by suite_name + slug)
   - `backend/src/routes/connectivity.ts` — admin-style DB introspection
   - `backend/src/routes/coverage.ts` — settings-update path (operates on `organizations`, not tenant data)
   - `backend/src/index.ts` — health check

   Any **new** `pool.query` in a tenant-scoped route is a finding unless commented with the reason. The smoke is: does this handler execute under `requireAuth`? If yes, and the table being touched has `org_id`, it must go through `tenantQuery`.

4. **Cross-org reachability on live / storage routes.** A few endpoints take a `:runId` path param and act on it:
   - `POST /live/:runId/events`, `/abort`, `/snapshot`, `/screenshot`, GET `/live/:runId/history`, `/stream`
   - GET `/runs/:id`, related deep-link endpoints

   Each must verify the run belongs to the caller's org **before** the work — the comment "Verify the run belongs to the caller's org" appears in `backend/src/routes/live.ts` for the events handler. Confirm the same `tenantQuery(orgId, "SELECT 1 FROM runs WHERE id = $1", [runId])` (or equivalent) gate exists on every `:runId` handler. The SSE `/stream` endpoint is the canonical gotcha — without the gate, an authenticated user from a different org can subscribe to another org's live events.

5. **JWT in query string.** `EventSource` doesn't support `Authorization: Bearer`, so `/live/:runId/stream` accepts the token as `?token=…`. Verify the token-from-query path also runs through the same JWT verification + org binding. Token-in-URL is an accepted footgun for SSE; the mitigation is short TTL + HTTPS + scoped to that one path.

6. **API key paths.** API keys (created via `/auth/api-keys`) are hashed with the prefix retained for fast lookup. Confirm `lookup_api_key()` is called via `pool.query` (legit, pre-tenant) and that the result sets `req.user.orgId` from `api_keys.org_id`, not from the body or a header.

## Report

Group findings by severity:

- **Critical** — a route exposes tenant data to anonymous callers; a route lets one org read/write another org's rows because tenant context wasn't set.
- **High** — `req.user!` reachable in a path that isn't gated; a `:runId` handler doesn't verify ownership.
- **Medium** — new `pool.query` in a tenant-scoped route without a comment explaining why; a per-route auth check that duplicates (and could drift from) the global one.
- **Low** — public mount missing a comment explaining why it's public.

For each: file:line, the concrete fix, the worst-case blast radius.

## Useful starting points

- `backend/src/index.ts` — every `app.use(...)`. The full picture of who's gated and who isn't.
- `backend/src/auth.ts` — `requireAuth` middleware, JWT + API key resolution.
- `backend/src/db.ts` — `tenantQuery` / `tenantTransaction`. The `set_config` line is what closes the loop.
- `backend/src/routes/live.ts` — the canonical "verify the run belongs to the caller's org" gate.
- `backend/CLAUDE.md` — the documented constraint: "Runs as DB user `flakey_app` (non-superuser) so RLS policies apply. Don't bypass this by connecting as a superuser."

## Delegate to

Use the `flakey-auditor` agent. Pass it the audit area as the prompt's first sentence: `"Audit auth gating and tenantQuery enforcement across the backend API."` That agent has the project's auth conventions baked in.

Read-only. Findings only.
