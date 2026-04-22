# Frontend audit

## High

- [ ] **`flakey_*` localStorage keys are user-visible branding leakage** — `frontend/src/lib/auth.ts:51-70`
  `localStorage.setItem("flakey_token", ...)`, `"flakey_user"`, `"flakey_refresh"` are set/read in `setAuth`, `clearAuth`, and `restoreAuth`. These keys are visible in DevTools and will persist across browser restarts. The CLAUDE.md mandates "Better Testing" for user-facing copy; localStorage keys are user-facing (visible, breakpoint-targetable). Rename to `bt_token`, `bt_user`, `bt_refresh` (or any non-"flakey" prefix). **Caution:** existing logged-in users will be logged out on deploy because `restoreAuth` won't find the renamed keys. Either run a one-time migration in `restoreAuth` (read both old and new keys, write new, delete old) or accept the forced re-login.

- [ ] **`VITE_API_URL` re-declared in 11 files instead of being read from the shared module** — `frontend/src/lib/api.ts:3`, `frontend/src/lib/auth.ts:1`, `frontend/src/routes/(app)/+page.svelte:7`, `frontend/src/routes/(app)/settings/+page.svelte:7`, `frontend/src/routes/(app)/settings/integrations/+page.svelte:5`, `frontend/src/routes/(app)/runs/[id]/+page.svelte:10`, `frontend/src/routes/(app)/releases/+page.svelte:5`, `frontend/src/routes/(app)/releases/[id]/+page.svelte:6`, `frontend/src/routes/(app)/manual-tests/+page.svelte:6`, `frontend/src/lib/components/AutomatedTestPicker.svelte:11`, `frontend/src/lib/components/RunExtras.svelte:8`, `frontend/src/routes/login/+page.svelte:6`, `frontend/src/routes/reset-password/[token]/+page.svelte:5`, `frontend/src/routes/verify-email/[token]/+page.svelte:6`
  Each file independently reads `import.meta.env.VITE_API_URL ?? "http://localhost:3000"`. If the default or variable name ever changes, 14 sites must be updated in sync. `api.ts` already exposes the full API client; `auth.ts` could export the constant. Files that don't go through `authFetch` (login, reset-password, verify-email) have a legitimate reason to import auth directly, but components/pages that hit authed endpoints should not re-declare this. Extract to `src/lib/config.ts` exporting `export const API_URL = ...` and import from there everywhere.

## Medium

- [ ] **`pnpm storybook` is advertised but no stories or `.storybook/` config exist** — `frontend/CLAUDE.md:12`, `frontend/package.json:12`
  CLAUDE.md says "`pnpm storybook` — Storybook on port 9999 (`--no-open`)". The script exists in `package.json` and all Storybook devDependencies are installed, but there is no `.storybook/` directory and no `*.stories.*` files anywhere under `frontend/`. Running `pnpm storybook` will fail. Either remove the line from CLAUDE.md and the `storybook`/`build-storybook` scripts + devDependencies, or create a minimal `.storybook/main.ts` and at least one story.

- [ ] **`vercel.json` is present but the active adapter is `adapter-static`, making the Vercel config a no-op** — `frontend/CLAUDE.md:22`, `frontend/svelte.config.js:1`, `frontend/vercel.json`
  CLAUDE.md says "Both adapters are installed... the production deploy goes to S3/CloudFront via `deploy.yml` using the static adapter." `svelte.config.js` imports only `adapter-static`. `vercel.json` is checked in but does nothing for a static build (SvelteKit ignores `vercel.json` when the static adapter is active). If Vercel is never the deploy target, remove `vercel.json` and `@sveltejs/adapter-vercel` from devDependencies. If it's a fallback deploy path, document which adapter to swap to and under what condition. The current CLAUDE.md is contradictory: it lists both as installed and says production uses static, but doesn't explain when `adapter-vercel` would be used.

- [ ] **`svelte.config.js` suppresses `svelte_component_deprecated` and `slot_element_deprecated` globally in source files** — `frontend/svelte.config.js:40-54`
  `warningFilter` silences `svelte_component_deprecated` and `slot_element_deprecated` not only for `node_modules` / `.svelte-kit` (the intended scope) but for all files because of the second `if` block at lines 52-55 that runs regardless of `ignorePatterns`. CLAUDE.md says "Svelte 5 runes only" — if the codebase were clean, these warnings would never fire and suppressing them globally would be harmless. But suppressing them hides any regression where a developer introduces `<slot>` or a Svelte 4 component usage. Remove the second `if` block (lines 52-55) so the filter only suppresses those codes when the filename matches `node_modules` or `.svelte-kit`.

## Low

- [ ] **CLAUDE.md doesn't document the auth module shape or the `authFetch` wrapper** — `frontend/CLAUDE.md`
  Auth is non-obvious: `auth.ts` holds a module-level singleton `state`, exposes `authFetch` (auto-refresh on 401), `restoreAuth` (reads localStorage on mount), and `subscribe` (manual listener list — not a Svelte store). Any agent touching auth or adding a new API call needs to know to use `authFetch`, not bare `fetch`. Add a short section to CLAUDE.md: auth state is a plain singleton (not a Svelte store), `authFetch` handles token injection and one-shot refresh, call `restoreAuth()` in layout `onMount`.

- [ ] **CLAUDE.md doesn't mention the `$app/stores` `page` usage pattern vs `$app/navigation`** — `frontend/CLAUDE.md`
  Several pages use `$page.url.searchParams` for filter state with `history.replaceState` for URL sync (see `flaky/+page.svelte:25-38`). This is a non-obvious pattern that will be re-invented inconsistently without documentation. One bullet in CLAUDE.md covering the URL-state sync pattern would prevent drift.

- [ ] **No tests exist anywhere in `frontend/`** — audit finding, not a doc error
  Zero `.test.*` or `.spec.*` files exist. CLAUDE.md doesn't mention testing at all (no vitest config, no Playwright config). This is a gap, not a documentation lie. Add a line to CLAUDE.md acknowledging the current state so agents don't spend time searching for tests: "No unit or integration tests currently. Vitest is not configured."
