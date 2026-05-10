# frontend

SvelteKit + Svelte 5 dashboard. Package name is `better-testing` (legacy — not user-visible, kept to avoid lockfile churn).

## Commands

- `pnpm dev` — vite dev server on **port 7777**
- `pnpm build` — production build
- `pnpm preview` — preview the built app on port 8888
- `pnpm check` — `svelte-kit sync` + `svelte-check` (type check). Run this before claiming a task done.

## Conventions

- **Svelte 5 runes only**: use `$state`, `$derived`, `$effect`, `$props`. Do not regress to Svelte 4 `let`/`$:`/`export let` reactivity.
- API base URL is exported as `API_URL` from `src/lib/config.ts`. Import it from there — do not re-declare `import.meta.env.VITE_API_URL` in individual files.
- Routes live in `src/routes/`; shared logic and components in `src/lib/`.
- User-facing strings say **"Flakey"**. The earlier "Better Testing" rebrand has been reverted; keep new copy consistent with "Flakey".

## Auth module

Auth state is a plain singleton in `src/lib/auth.ts` (not a Svelte store). Key exports:

- `authFetch(url, opts?)` — wraps `fetch` with Bearer token injection and automatic one-shot refresh on 401. Use this for all authenticated requests.
- `restoreAuth()` — reads auth from `localStorage` (keys `bt_token`, `bt_user`, `bt_refresh`). Call it in the root layout's `onMount`.
- `subscribe(fn)` — manual listener registration (returns an unsubscribe function).

`localStorage` keys use the `bt_` prefix — a holdover from the earlier "Better Testing" rebrand. The brand is back to Flakey but the keys stay `bt_*`: they aren't user-visible and reverting them would invalidate every signed-in session. `restoreAuth` still migrates any legacy `flakey_*` keys it finds.

## URL-state sync pattern

Several pages keep filter state in the URL using `$page.url.searchParams` and write it back with `history.replaceState`. This avoids full navigation for filter changes while keeping views bookmarkable and shareable. See `src/routes/(app)/flaky/+page.svelte` for the canonical example.

## Deployment

Production deploy targets S3/CloudFront via `deploy.yml` using `@sveltejs/adapter-static`. There is no Vercel configuration.

## Tests

Vitest 4 is configured for **pure-helper unit tests only** (e.g. `src/lib/toast.test.ts`). Run with `pnpm test` (one-shot) or `pnpm test:watch`. Test files live next to the source as `*.test.ts` and run in Node environment by default — pick up `vitest.config.ts` if a test needs a different env (`jsdom`, `happy-dom`).

What is **not** tested here, by design:

- **Svelte 5 component behaviour.** Runes-mode component testing is fiddly and the value-to-effort is poor. Component-level UX is covered by Playwright e2e (`tests-e2e/`) instead.
- **The auth singleton (`auth.ts`)** — touches `localStorage` + `fetch`. Tested end-to-end via Playwright login flow.
- **Route loaders / `+page.svelte` files** — covered by Playwright.

Add a vitest spec only when the target is a pure function (no DOM, no global side-effects beyond the module's own state). For anything user-visible, write a Playwright test instead.

End-to-end coverage lives in `tests-e2e/` (Playwright). Run with `pnpm test:e2e` (or `pnpm test:e2e:ui` for the UI runner). Prereqs (running backend + seeded Postgres) are in [`tests-e2e/README.md`](tests-e2e/README.md).
