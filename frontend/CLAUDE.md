# frontend

SvelteKit + Svelte 5 dashboard. Package name is `better-testing` (post-rebrand).

## Commands

- `pnpm dev` — vite dev server on **port 7777**
- `pnpm build` — production build
- `pnpm preview` — preview the built app on port 8888
- `pnpm check` — `svelte-kit sync` + `svelte-check` (type check). Run this before claiming a task done.
- `pnpm storybook` — Storybook on port 9999 (`--no-open`)

## Conventions

- **Svelte 5 runes only**: use `$state`, `$derived`, `$effect`, `$props`. Do not regress to Svelte 4 `let`/`$:`/`export let` reactivity.
- API base URL comes from `VITE_API_URL` (default `http://localhost:3000`).
- Routes live in `src/routes/`; shared logic and components in `src/lib/`.
- User-facing strings say **"Better Testing"**, not "Flakey". The rebrand landed in commit 95efd7d — keep new copy consistent.

## Deployment targets

Both `@sveltejs/adapter-static` and `@sveltejs/adapter-vercel` are installed. `vercel.json` is checked in; the production deploy goes to S3/CloudFront via `deploy.yml` using the static adapter.
