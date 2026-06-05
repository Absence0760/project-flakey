---
description: Generate a canonical inventory of the backend HTTP API by reading the Express routes — feeds external integrators (no OpenAPI is published) and gives /audit/docs-drift a ground-truth list to diff docs against.
---

Produce a canonical, table-shaped inventory of every backend HTTP endpoint by reading the Express routers — not by trusting any doc.

There is **no codegen** in project-flakey (request/response types are hand-synced across `backend/src/types.ts`, `frontend/src/lib/api.ts`, and the DB schema) and **no published OpenAPI / API spec**. So the route source itself is the only ground truth for "what endpoints exist." This command flattens that into one artifact two audiences need:

- **External integrators** wiring against the API (CI uploaders, badge embeds, webhook/PagerDuty/Jira callers) who have no spec to read.
- **`/audit/docs-drift`**, which currently re-derives the endpoint list every run to diff `docs/architecture.md` § "Authenticated endpoints" against reality. Hand it a maintained inventory instead.

This is a **generator**, not a findings audit. It describes what the API *is*; it does not flag bugs. Read-only on the codebase except for writing the one output file.

## What it produces

`reviews/endpoint-inventory.md` — one row per registered route, in router-mount order (the order they appear in `backend/src/index.ts`). Columns:

| Method | Path | Auth | Tenant-scope | Request params | Response shape | Notes |
|--------|------|------|--------------|----------------|----------------|-------|

Column semantics — fill each from the actual code, never inferred:

- **Method** — `GET` / `POST` / `PATCH` / `PUT` / `DELETE`, from the `router.<verb>(...)` call.
- **Path** — full path: the mount prefix in `index.ts` (`app.use("/runs", ...)`) joined to the in-router path (`router.get("/:id/specs", ...)`) → `GET /runs/:id/specs`.
- **Auth** — `requireAuth` for the protected mounts, or `public` for the four unauthenticated paths: `/health`, `/auth/login`, `/auth/register`, `/badge/*`. Note that `/auth` is mounted **without** router-level `requireAuth` (see the comment at `index.ts` ~L336): its router mixes public handlers (login, register, forgot-password, reset-password, resend-verification, verify-email, refresh, logout, registration-status) with per-handler-gated protected ones (`/me`, `/switch-org`, `/api-keys`). Mark each `/auth/*` row by inspecting whether that specific handler attaches `requireAuth,`.
- **Tenant-scope** — `tenantQuery` / `tenantTransaction` (RLS-scoped to `req.user!.orgId`) is the norm. Flag the exceptions explicitly: `pool.query` cross-org calls (e.g. `badge.ts` L50 looks up the org by slug via raw `pool.query` before scoping the runs query through `tenantQuery`), and routes that touch no tenant data at all (`/health`, `/connectivity/*`). A raw `pool.query` against tenant tables is a finding for `/audit/auth` — note it, don't fix it here.
- **Request params** — path params (`:id`, `:runId`, `:orgSlug/:suiteName`), query params (the real casing — e.g. `?suite=`, `?runs=`, `?from=`/`?to=`, `?page=`), and the body shape for POST/PATCH. Use the names the handler actually reads, not the doc's names.
- **Response shape** — the `frontend/src/lib/api.ts` interface name when one maps (`Run`, `RunDetail`, `TestDetail`, `TestHistory`, `ErrorGroup`, `FlakyTest`, `DashboardStats`, `TrendsData`, `CompareResult`, `SavedView`, `QuarantinedTest`, etc.). If no interface maps (server-only routes, raw JSON, SVG, 302 redirect), say so plainly (e.g. `SVG`, `302 → artifact URL`, `{ status: "ok" }`).

Then two short cross-reference sections:

- **Server-only routes (no frontend client function).** Routes that exist in `backend/src/routes/*.ts` but have no matching call in `frontend/src/lib/api.ts` — typically integration/webhook/badge/upload surfaces consumed by CI tooling or external callers, not the SPA: `POST /runs/upload` (reporter uploads), `GET /badge/:orgSlug/:suiteName` (embeddable SVG), the `/webhooks` and `/pagerduty` delivery paths, the `/live/:runId/{events,snapshot,screenshot,abort}` reporter ingest, `/connectivity/*`. These are the integrator-facing surface — call them out as such.
- **Client functions with no matching route (drift).** `api.ts` exports (e.g. `fetchRuns`, `fetchRun`, `fetchEnvironments`, `analyzeError`, `quarantineTest`, …) whose URL no longer resolves to a registered route. Each is a real bug — a dead client call. List them with the `api.ts` line.

## Procedure

1. **Read the registration order.** `backend/src/index.ts` is the source of truth for which routers mount at which prefix, the global `requireAuth` gating, and the four public mounts. Note the `/auth` (per-handler gating), `/badge` (public), `/runs/upload` (mounted before `/runs`, behind `uploadLimiter`), and `/live` (query-token → Bearer promotion for `EventSource`) special cases.
2. **Read each router.** For every `import ... from "./routes/<name>.js"` in `index.ts`, open `backend/src/routes/<name>.ts` and enumerate its `router.<verb>(path, ...)` handlers. There are 32 route files (`a11y` … `webhooks`); don't sample — read them all.
3. **Resolve tenant-scope per handler** by grepping for `tenantQuery` / `tenantTransaction` / `pool.query` in each file and noting which the handler uses.
4. **Cross-reference `frontend/src/lib/api.ts`** — match each `fetch(...)`/client function's URL to a registered route to populate the response-shape column and build the two drift sections.
5. **Write `reviews/endpoint-inventory.md`** (overwrite if present). Lead with a one-line note: *generated from the route source on `<date>`; regenerate after adding routes.* This artifact can be **promoted to `docs/`** as a maintained, committed inventory if the team wants it under version control — `reviews/` is gitignored, so by default it's a working snapshot.

**Delegate to** the `general-purpose` agent: pass this file as the prompt. The agent reads `index.ts` + all of `backend/src/routes/*.ts` + `frontend/src/lib/api.ts` and writes the single output file. Read-only on the rest of the codebase — no other edits, no git.

## Notes

- This is a generator, not an audit. It does not grade `requireAuth` coverage or RLS discipline — it just records the current state. For findings, pair it with **`/audit/auth`** (route gating + `tenantQuery` discipline) and **`/audit/docs-drift`** (which can diff its own endpoint scan against this inventory).
- An **API-contract** check (request/response shapes matching across `backend/src/types.ts` ↔ `api.ts` ↔ DB, given there's no codegen) is the natural companion when one exists.
- **Re-run after adding or moving routes** — a new `app.use(...)` mount or a new `router.<verb>(...)` handler makes the inventory stale immediately, and `/audit/docs-drift` starts diffing against an out-of-date list.
