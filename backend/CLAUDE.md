# backend

Express + Node + TypeScript API. Multi-tenant via Postgres Row-Level Security.

## Commands

- `npm run dev` — tsx watch with `.env` loading
- `npm run seed` — seed sample data (2 users, 2 orgs, 56 runs across Mochawesome/Playwright/JUnit)
- `npm test` — `node --test` over `src/tests/**/*.test.ts` via tsx
- `npm run build` — `tsc` → `dist/`
- `npm start` — run the built `dist/index.js`

## Package manager

Use **npm** here, not pnpm. The backend has its own lockfile and is intentionally outside the pnpm workspace.

## Key constraints

- Runs as DB user `flakey_app` (non-superuser) so RLS policies apply. Don't bypass this by connecting as a superuser.
- Migrations live in `migrations/`; apply via `./migrate.sh`.
- `JWT_SECRET` is required in production (no default).
- Secrets for integrations (Jira tokens, PagerDuty keys) are AES-256-GCM encrypted via `FLAKEY_ENCRYPTION_KEY`. If the key is unset, the code falls back to plaintext passthrough — only acceptable in local dev.

## Layout

- `src/routes/` — Express route handlers
- `src/normalizers/` — per-reporter adapters (Mochawesome, JUnit, Playwright, Jest, WebdriverIO)
- `src/integrations/` — Jira, PagerDuty, scheduled reports, webhooks
- `src/git-providers/` — GitHub, GitLab, Bitbucket PR-comment + status adapters
- `src/tests/` — integration tests (hit a real Postgres; see `docs/testing.md`)

## Email

`src/email.ts` handles SMTP for auth verification, password reset, and scheduled reports. The default `EMAIL_FROM` still references the old brand (`Flakey <noreply@flakey.dev>`) — update it when configuring real SMTP.
