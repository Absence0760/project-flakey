# frontend

SvelteKit + Svelte 5 dashboard. Package name is `better-testing` (legacy — not user-visible, kept to avoid lockfile churn).

## Commands

- `pnpm dev` — vite dev server on **port 7778**
- `pnpm build` — production build
- `pnpm preview` — preview the built app on port 8888
- `pnpm check` — `svelte-kit sync` + `svelte-check` (type check). Run this before claiming a task done.

## Conventions

- **Svelte 5 runes only**: use `$state`, `$derived`, `$effect`, `$props`. Do not regress to Svelte 4 `let`/`$:`/`export let` reactivity.
- API base URL is exported as `API_URL` from `src/lib/utils/config.ts`. Import it from there — do not re-declare `import.meta.env.VITE_API_URL` in individual files.
- Routes live in `src/routes/`; shared logic and components in `src/lib/`. Within `src/lib`: `stores/` (stateful singletons — `auth`, `toast`), `utils/` (pure helpers — `config`, `safe-url`, `snapshot-match`), `api.ts` (the central API client), and `components/` grouped by kind (`charts/`, `media/`, `inputs/`, `overlays/`, `panels/`, `status/`).
- User-facing strings say **"Flakey"**. The earlier "Better Testing" rebrand has been reverted; keep new copy consistent with "Flakey".

## Auth module

Auth state is a plain singleton in `src/lib/stores/auth.ts` (not a Svelte store). Key exports:

- `authFetch(url, opts?)` — wraps `fetch` with Bearer token injection and automatic one-shot refresh on 401. Use this for all authenticated requests.
- `restoreAuth()` — reads auth from `localStorage` (keys `bt_token`, `bt_user`, `bt_refresh`). Call it in the root layout's `onMount`.
- `subscribe(fn)` — manual listener registration (returns an unsubscribe function).

`localStorage` keys use the `bt_` prefix — a holdover from the earlier "Better Testing" rebrand. The brand is back to Flakey but the keys stay `bt_*`: they aren't user-visible and reverting them would invalidate every signed-in session. `restoreAuth` still migrates any legacy `flakey_*` keys it finds.

## URL-state sync pattern

Several pages keep filter state in the URL using `$page.url.searchParams` and write it back with SvelteKit's `replaceState` from `$app/navigation`. This avoids full navigation for filter changes while keeping views bookmarkable and shareable. See `src/routes/(app)/flaky/+page.svelte` for the canonical example.

When deciding whether to write a param, compare against the **default only** (`if (v !== def)`), never truthiness (`if (v && v !== def)`). An empty string can be a deliberate, non-default selection (e.g. a run with a blank suite name); the truthiness form silently drops it from the URL so it never persists across reload/round-trip. A search box whose default *is* `""` still drops correctly because `"" === def`. (This was a real bug — see the empty-value regression test in `tests-e2e/cross-cutting/url-state-bookmarks.spec.ts`.)

Because the sidebar links are bare paths (`/runs`), a round-trip through the nav would otherwise drop those query strings. `src/lib/stores/section-views.svelte.ts` (a Svelte 5 rune store, localStorage-backed) remembers each section's last query string; the `(app)` layout captures it as the user filters and points each sidebar link at `item.href + viewFor(item.href)` so filters survive away-and-back navigation, reloads, new tabs, and later visits in the same browser. New top-level filterable pages get this for free as long as they keep their filters in the URL.

## The /errors triage surface

`src/routes/(app)/errors/+page.svelte` is the failure-triage surface (Phase 15). An error group is the triage unit: it carries a status, an owner (`AssigneePicker`), a manual `priority` chip, and a `target_date` due date. The detail-pane mutating controls (status / owner / priority / due date) are gated on `canEdit` (`getAuth().user?.orgRole !== 'viewer'`); the backend also 403s the writes, so this is defence-in-depth, not the only gate. The list/filter selection logic ("All failures" / "Assigned to me" / "Overdue") lives as **pure helpers** in `src/lib/utils/error-triage.ts` (`applyTriageFilter`, `isOverdue`, `todayISO`) so it's unit-testable — see `error-triage.test.ts`. The triage filter is a client-side layer on top of the server-side suite/status filters and participates in the URL-state sync (the `triage` param).

## Deployment

Production deploy targets S3/CloudFront via `deploy.yml` using `@sveltejs/adapter-static`. There is no Vercel configuration.

## Tests

Vitest 4 is configured for **pure-helper unit tests only** (e.g. `src/lib/stores/toast.test.ts`). Run with `pnpm test` (one-shot) or `pnpm test:watch`. Test files live next to the source as `*.test.ts` and run in Node environment by default — pick up `vitest.config.ts` if a test needs a different env (`jsdom`, `happy-dom`).

What is **not** tested here, by design:

- **Svelte 5 component behaviour.** Runes-mode component testing is fiddly and the value-to-effort is poor. Component-level UX is covered by Playwright e2e (`tests-e2e/`) instead.
- **The auth singleton (`stores/auth.ts`)** — touches `localStorage` + `fetch`. Tested end-to-end via Playwright login flow.
- **Route loaders / `+page.svelte` files** — covered by Playwright.

Add a vitest spec only when the target is a pure function (no DOM, no global side-effects beyond the module's own state). For anything user-visible, write a Playwright test instead.

End-to-end coverage lives in `tests-e2e/` (Playwright). Run with `pnpm test:e2e` (or `pnpm test:e2e:ui` for the UI runner). Prereqs (running backend + seeded Postgres) are in [`tests-e2e/README.md`](tests-e2e/README.md).
