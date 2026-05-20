## Summary

<!-- 1–3 sentences on what this PR does and why. -->

## Changes

<!-- Bulleted list of the user-visible or developer-visible changes. -->

-
-

## Surface touched

- [ ] Backend API (`backend/src/`)
- [ ] Database migrations (`backend/migrations/`)
- [ ] Frontend dashboard (`frontend/src/`)
- [ ] Reporter / CLI / MCP package (`packages/*/src/`)
- [ ] Infrastructure (`infra/`)
- [ ] CI / GitHub Actions (`.github/workflows/`)
- [ ] E2E tests (`frontend/tests-e2e/`)
- [ ] Examples (`examples/`)
- [ ] Docs only

## Multi-tenant / security checklist

<!-- Tick what applies. Untick lines that genuinely don't apply, but
     don't delete the row — so the next reviewer can see you considered
     it. See CLAUDE.md for the four trust boundaries. -->

- [ ] New tenant-table reads go through `tenantQuery` / `tenantTransaction` (no raw `pool.query` against `runs` / `specs` / `tests` / org-scoped tables)
- [ ] New endpoint is mounted under the `requireAuth` middleware (or has a documented reason it's public)
- [ ] New migration enables RLS on every new tenant table and ships matching policies
- [ ] Uploaded-filename paths are sanitised before joining into a storage key
- [ ] No server-only secret (`JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, integration tokens) is read from the client bundle
- [ ] No required secret has a hardcoded fallback (`process.env.X || "..."`)
- [ ] User-rendered content uses `{value}` not `{@html value}` (or escaping is justified inline)

## Test plan

<!-- How this was verified. Delete rows that don't apply. -->

- [ ] `npm test` passes in `backend/`
- [ ] `pnpm check` passes in `frontend/`
- [ ] `pnpm test:e2e` passes (when the change affects routed UI)
- [ ] Manual walkthrough on the affected surface (describe below)

<!-- Manual walkthrough notes: -->
