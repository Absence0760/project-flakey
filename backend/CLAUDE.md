# backend

Express + Node + TypeScript API. Multi-tenant via Postgres Row-Level Security.

## Commands

- `npm run dev` — tsx watch with `.env` loading
- `npm run seed` — seed sample data (2 users, 2 orgs, 56 runs across Mochawesome/Playwright/JUnit)
- `npm test` — `node --test` over `src/tests/**/*.test.ts` via tsx
- `npm run build` — `tsc` → `dist/`
- `npm start` — run the built `dist/index.js`
- `npm run rotate-keys` — re-encrypt all org secrets under the current primary key (see `docs/integrations.md` for the dual-key rotation procedure)

## Package manager

Use **npm** here, not pnpm. The backend has its own lockfile and is intentionally outside the pnpm workspace.

## Layout

- `src/integrations/` — Jira, PagerDuty, scheduled reports, coverage-gate logic
- `src/git-providers/` — GitHub/GitLab/Bitbucket PR-comment + commit-status adapters

Everything else (`src/routes/`, `src/normalizers/`, `src/tests/`) is self-describing.

## Key constraints

- Runs as DB user `flakey_app` (non-superuser) so RLS policies apply. Don't bypass this by connecting as a superuser.
- Migrations live in `migrations/`; apply via `./migrate.sh`.
- `JWT_SECRET` is required in production (no default).
- Secrets for integrations (Jira tokens, PagerDuty keys) are AES-256-GCM encrypted via `FLAKEY_ENCRYPTION_KEY`. If the key is unset, the code falls back to plaintext passthrough — only acceptable in local dev.
- `SMTP_*` + `EMAIL_FROM` control transactional mail (auth verification, password reset) and scheduled report delivery; all have safe defaults for local dev.
