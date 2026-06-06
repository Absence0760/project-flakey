# backend

Express + Node + TypeScript API. Multi-tenant via Postgres Row-Level Security.

## Commands

- `npm run dev` — tsx watch with `.env` loading
- `npm run seed` — seed sample data: 3 primary users (`admin@example.com`/`admin`, `demo@example.com`/`demo123`, `viewer@example.com`/`viewer123`), 2 primary orgs (Acme Corp, Demo Team), ~85 runs across ~25 suites spanning Mochawesome/Playwright/JUnit, plus demoable extras: a known admin API key (`fk_demoadmindemoadmindemoadmindemoa`) for CLI testing, one webhook target at `https://example.invalid/seeded-hook`, two quarantine entries, two non-default error-group statuses (investigating + known), and one pending org invite (`token: demo-invite-token-do-not-use-in-prod-aaaa`). Also seeds **4 worker tenants** (`admin+w{0..3}@example.com` / `worker{0..3}123`, orgs `acme-w{0..3}`) with the same playground content as Acme (minus the global-unique API key + invite token) so parallel Playwright workers can each operate on a dedicated tenant. Override the worker-tenant count with `E2E_WORKER_TENANTS=N` (default 4; set to 0 for a slim production seed).
- `npm test` — `node --test` over `src/tests/**/*.test.ts` via tsx
- `npm run build` — `tsc` → `dist/`
- `npm start` — run the built `dist/index.js`
- `npm run rotate-keys` — re-encrypt all org secrets under the current primary key (see `docs/integrations.md` for the dual-key rotation procedure)
- `npm run replay-payload -- <path> [--reporter <type>] [--pretty]` — feed a captured reporter payload (Cypress/mochawesome JSON, Playwright/Jest/WebdriverIO JSON, JUnit XML) straight through the normalizer and dump the `NormalizedRun` to stdout (stats summary on stderr). No DB, no auth — a sub-second loop on ingestion bugs without standing up the stack. Reporter is auto-detected from the filename when `--reporter` is omitted.

## Package manager

Use **npm** here, not pnpm. The backend has its own lockfile and is intentionally outside the pnpm workspace.

## Layout

- `src/integrations/` — Jira, PagerDuty, coverage-gate logic; scheduled reports live in `src/scheduled-reports.ts`
- `src/git-providers/` — GitHub/GitLab/Bitbucket PR-comment + commit-status adapters

Everything else (`src/routes/`, `src/normalizers/`, `src/tests/`) is self-describing.

## Ports

- API listens on `PORT` (default `3000`). Health probe: `GET /health`.
- Dev frontend defaults to `7778` (Vite); `CORS_ORIGINS` default in dev allow-lists `http://localhost:7778,http://localhost:3000`.

## Key constraints

- Runs as DB user `flakey_app` (non-superuser) so RLS policies apply. Don't bypass this by connecting as a superuser.
- Migrations live in `migrations/`; apply via `./migrate.sh`.
- `JWT_SECRET` is required in production (no default).
- **First admin is env-gated — no default credentials ship.** A fresh DB comes up with zero users (migration `003_auth.sql` no longer seeds a known admin). To create the first admin, set both `FLAKEY_BOOTSTRAP_ADMIN_EMAIL` and `FLAKEY_BOOTSTRAP_ADMIN_PASSWORD`; on boot, `src/bootstrap-admin.ts` idempotently creates that user (role `admin`, bcrypt cost 12), a personal org, and an `owner` membership — mirroring `POST /auth/register`. If either var is unset it no-ops. It never resets an existing user's password, so it's safe to leave set across restarts. In dev, `npm run seed` still creates `admin@example.com`/`admin` directly (independent of this bootstrap).
- Secrets for integrations (Jira tokens, PagerDuty keys) are AES-256-GCM encrypted via `FLAKEY_ENCRYPTION_KEY`. If the key is unset, the code falls back to plaintext passthrough — only acceptable in local dev. The key FORMAT (32 bytes, hex or base64) is validated at boot — a malformed value refuses to start, not just an unset one.
- `SMTP_*` + `EMAIL_FROM` control transactional mail (auth verification, password reset) and scheduled report delivery; all have safe defaults for local dev.
- Login hardening (see `docs/architecture.md` § 4 for the full picture): per-account lockout via `LOGIN_LOCKOUT_THRESHOLD` (default 5) / `LOGIN_LOCKOUT_MINUTES` (default 15) on top of the per-IP `AUTH_RATE_LIMIT_MAX` gate, bcrypt-bounded response time on unknown emails (no enumeration via timing), refresh-token revocation + rotation via the `revoked_refresh_tokens` table, and per-request org-membership re-validation in `requireAuth` so removed members 401 immediately.
- **Cross-org support access is `is_support` + read-only.** `users.is_support` (migration 053) is a platform flag set out-of-band by an operator — there is no API to grant it. A support user calls `POST /support/orgs/:orgId/token` to mint a 30-min read-only "view as org" JWT (audited as `support.session.start` in the target org). `requireAuth` clamps such a session to `GET` on an allow-listed read surface (see `SUPPORT_READ_BASEURLS` in `auth.ts`) — never the secrets/config routes — and re-checks `is_support` live so revoking it ends sessions immediately. No user impersonation. Details in `docs/architecture.md` § 4.
