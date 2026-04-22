# Root docs audit

## High — docs contradict reality

- [ ] **`architecture.md:168` — JWT expiry is wrong.** Claims "receive a JWT (7-day expiry)". Code reality: `backend/src/auth.ts:10-11` defines `ACCESS_EXPIRY = "1h"` and `REFRESH_EXPIRY = "7d"` — it's a short-lived access token plus a separate refresh token, not a single 7-day JWT. The README (`README.md:248`) correctly describes "1hr access + 7d refresh tokens". Fix: change line 168 to "receive a short-lived access token (1h) and a refresh token (7d)".

- [ ] **`architecture.md:184` — roles list is stale.** Says "Roles: owner, admin, member". Migration `backend/migrations/007_viewer_role.sql:3` renamed `member` → `viewer` and enforces `CHECK (role IN ('owner', 'admin', 'viewer'))`. The backend source code (`src/routes/ui-coverage.ts`, `src/routes/webhooks.ts`, etc.) gates on `orgRole === "viewer"` throughout. Fix: change to "Roles: owner, admin, viewer".

- [ ] **`README.md:26` — wrong package manager for flakey-cli install.** Says `cd packages/flakey-cli && npm install`. The `packages/flakey-cli/` directory contains `pnpm-lock.yaml`, not a `package-lock.json`. `docs/run-locally.md:29` correctly says `pnpm install`. Fix: change to `pnpm install`.

- [ ] **`README.md:40` — wrong command to start the app.** Says `npm run dev`. The root `package.json` only defines pnpm scripts; there is no `npm run dev` script at the root. Fix: change to `pnpm dev`.

- [ ] **`README.md:210` and `architecture.md:305` — API key management is in Settings, not a Profile page.** README:210 says "Create an API key from the Profile page". `architecture.md:305` says "Profile — account info, API key management (create/list/delete)". There is no `/profile` route in `frontend/src/routes/(app)/`. The profile popover in the layout has no link to an API-keys page. API keys live in the Settings page (`frontend/src/routes/(app)/settings/+page.svelte`, line 609+). `docs/run-locally.md:109` correctly says "Go to **Settings** (sidebar)". Fix: change both references to "Settings page".

- [ ] **`README.md:365` — `publish.yml` package list is incomplete.** Says it publishes `@flakeytesting/cli`, `cypress-reporter`, `playwright-reporter`, `webdriverio-reporter`, and `cypress-snapshots` — 5 packages. `.github/workflows/publish.yml` actually publishes 9: all of the above plus `core`, `playwright-snapshots`, `live-reporter`, and `mcp-server`. The npm packages table (`README.md:369-378`) also omits `@flakeytesting/live-reporter` and `@flakeytesting/mcp-server`, both of which exist under `packages/`. Fix: update the publish.yml description to "all packages in `packages/`" and add the two missing rows to the npm packages table.

## Medium — stale or ambiguous

- [ ] **`docs/run-locally.md:57` — seed run count is understated.** Says "50 sample test runs spread across 18 months". The seed script (`backend/src/seed.ts:329`) loops 50 times for the main batch, then inserts 3 Playwright runs (line ~537) and 3 JUnit runs (line ~627) for Phase 9/10 data — 56 total. `backend/CLAUDE.md` correctly says 56. Fix: change "50 sample test runs" to "56 sample test runs (50 main + 3 Playwright + 3 JUnit)".

- [ ] **`root package.json:8` — `dev:backend` uses pnpm inside backend, contradicting CLAUDE.md.** `CLAUDE.md:26` says "Don't run pnpm inside `backend/`." The root `package.json:8` defines `dev:backend` as `cd backend && pnpm dev`. The backend has both `package-lock.json` and `pnpm-lock.yaml`; the lockfiles diverged (pnpm-lock.yaml is from April 8, package-lock.json was updated more recently). Either update CLAUDE.md to permit `pnpm dev` inside backend when called from the root, or change the root script to `cd backend && npm run dev`. The inconsistency will confuse contributors who follow CLAUDE.md and use `npm` inside backend directly.

## Low — style/context-window optimization

- [ ] **`CLAUDE.md` "Layout" section (lines 8–14) is pure directory restatement.** Every bullet restates what the directory name already implies (`backend/` — backend, `frontend/` — frontend). The only non-obvious entry is `infra/` (Terraform specifics) and the note about nested `CLAUDE.md` files. Trim to:
  ```
  ## Layout
  - `backend/` — Express/Node/TS; uses npm (not pnpm)
  - `frontend/` — SvelteKit (Svelte 5); uses pnpm workspace
  - `packages/` — `@flakeytesting/*` npm packages
  - `infra/` — Terraform: AWS ECS Fargate + RDS + S3/CloudFront
  Each subdirectory has its own CLAUDE.md — read it before editing.
  ```

- [ ] **`CLAUDE.md` "Publish flow" section (lines 36–37) duplicates `publish.yml` detail.** The example commit message (`chore(cypress-snapshots): bump version to 0.5.0`) is implementation trivia, not a convention Claude needs. The meaningful rule is "version bumps are explicit commits". Trim to one line: "`publish.yml` publishes packages to npm on `main` when their source changes. Bump versions with an explicit commit."
