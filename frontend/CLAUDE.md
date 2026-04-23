# frontend

SvelteKit + Svelte 5 dashboard. Package name is `better-testing` (post-rebrand).

## Commands

- `pnpm dev` — vite dev server on **port 7777**
- `pnpm build` — production build
- `pnpm preview` — preview the built app on port 8888
- `pnpm check` — `svelte-kit sync` + `svelte-check` (type check). Run this before claiming a task done.

## Conventions

- **Svelte 5 runes only**: use `$state`, `$derived`, `$effect`, `$props`. Do not regress to Svelte 4 `let`/`$:`/`export let` reactivity.
- API base URL is exported as `API_URL` from `src/lib/config.ts`. Import it from there — do not re-declare `import.meta.env.VITE_API_URL` in individual files.
- Routes live in `src/routes/`; shared logic and components in `src/lib/`.
- User-facing strings say **"Better Testing"**, not "Flakey". The rebrand landed in commit 95efd7d — keep new copy consistent.

## Auth module

Auth state is a plain singleton in `src/lib/auth.ts` (not a Svelte store). Key exports:

- `authFetch(url, opts?)` — wraps `fetch` with Bearer token injection and automatic one-shot refresh on 401. Use this for all authenticated requests.
- `restoreAuth()` — reads auth from `localStorage` (keys `bt_token`, `bt_user`, `bt_refresh`). Call it in the root layout's `onMount`.
- `subscribe(fn)` — manual listener registration (returns an unsubscribe function).

`localStorage` keys use the `bt_` prefix (Better Testing). On first load after the rename, `restoreAuth` migrates existing `flakey_*` keys to the new names automatically.

## URL-state sync pattern

Several pages keep filter state in the URL using `$page.url.searchParams` and write it back with `history.replaceState`. This avoids full navigation for filter changes while keeping views bookmarkable and shareable. See `src/routes/(app)/flaky/+page.svelte` for the canonical example.

## Deployment

Production deploy targets S3/CloudFront via `deploy.yml` using `@sveltejs/adapter-static`. There is no Vercel configuration.

## Tests

No unit or integration tests currently exist. Vitest is not configured. Do not spend time searching for test files.
