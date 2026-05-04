---
description: Sweep for server-only secrets that may have leaked into a client bundle, public asset, or git
---

Audit handling of `JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, integration tokens (Jira, PagerDuty, SMTP), API keys, and any secret reachable from the SvelteKit client bundle.

## Goal

The backend has two foundational secrets — `JWT_SECRET` (signs auth tokens) and `FLAKEY_ENCRYPTION_KEY` (AES-256-GCM for org-stored integration tokens). Plus per-org integration secrets (Jira API tokens, PagerDuty integration keys, SMTP passwords) that are encrypted-at-rest. A leak of any of these has different blast radii — find each on the wrong side of the trust boundary.

## What to check

1. **`.env*` and `.envrc` files in git.** Run `git log --all --full-history -- '.env' '.env.*' '.envrc'` to confirm no `.env` (the real one) has ever been committed. `.env.example` is fine. If a real env has been committed, the secret is permanently exposed regardless of removal — flag for **rotation**, not deletion.

2. **`JWT_SECRET` defaults.** `backend/CLAUDE.md` says: "JWT_SECRET is required in production (no default)." Two things must hold:
   - `backend/src/auth.ts` reads `process.env.JWT_SECRET` (currently with a `?? "flakey-dev-secret-change-me"` dev fallback — confirm the literal hasn't changed to something that looks production-grade).
   - `backend/src/index.ts` has the prod-only refuse-to-start guard (`if (IS_PROD && !process.env.JWT_SECRET) { …; process.exit(1); }`). Both layers are required: the fallback gives local dev a usable default; the guard makes prod fail closed instead of accepting it.

3. **`FLAKEY_ENCRYPTION_KEY` handling.** `backend/CLAUDE.md` says: "If the key is unset, the code falls back to plaintext passthrough — only acceptable in local dev." Read `backend/src/crypto.ts` and verify:
   - `encryptSecret()` returns the plaintext when no key is set (intentional dev passthrough)
   - `decryptSecret()` throws "Encrypted value present but no FLAKEY_ENCRYPTION_KEY is set" when an ENC value is read with no key (fail-closed read)
   - The optional `FLAKEY_ENCRYPTION_KEY_OLD` is wired only into the read path (key rotation) and never used for new writes
   - Cached primary/old keys are read via the helpers (`primaryKey()` / `oldKey()`), not by re-reading `process.env` mid-call

4. **Client-bundle leakage (web).** SvelteKit + Vite: only `import.meta.env.VITE_*` is inlined into the client bundle. Anything else in `import.meta.env` is server-only. Grep `frontend/src/` for:
   - `import.meta.env.` references that aren't `VITE_*`
   - `process.env.` references (Vite usually replaces these, but custom plugins may not)

   The repo's only intentional client env var should be `VITE_API_URL`, exported from `frontend/src/lib/config.ts` as `API_URL`. Any other client-visible env var needs justification.

5. **Auth localStorage convention.** `frontend/CLAUDE.md` says: "`localStorage` keys use the `bt_` prefix (Better Testing). On first load after the rename, `restoreAuth` migrates existing `flakey_*` keys." Confirm:
   - `bt_token` / `bt_user` / `bt_refresh` are written/read only from `frontend/src/lib/auth.ts`
   - No `localStorage.setItem` on these keys anywhere else (XSS exfil surface)
   - The migration helper from `flakey_*` → `bt_*` exists and runs on `restoreAuth`

6. **GitHub Actions workflows.** Walk `.github/workflows/*.yml`. For each `env:` line:
   - Uses `${{ secrets.X }}` form (not a literal value)
   - No `set -x` / verbose debug that would echo the env to logs
   - No `echo "$SECRET"` in a step

   Floating action refs (`uses: foo@v1` rather than `@<sha>`) on workflows that touch `${{ secrets.* }}` are a supply-chain risk worth flagging — they're medium, not critical, but list them.

7. **Encrypted secrets in DB.** Per `docs/integrations.md` (or wherever it's documented) integration tokens are AES-256-GCM encrypted in the `organizations` table (e.g. `jira_api_token`, `pagerduty_integration_key`, `smtp_password`). Confirm:
   - The columns aren't returned by GET endpoints — only `has_<x>` boolean flags (e.g. `has_api_token: true`)
   - PATCH handlers re-encrypt on update via `encryptSecret()`
   - The audit log doesn't capture the plaintext token (search `logAudit` callsites that pass the raw body)

8. **API keys.** `backend/src/routes/auth.ts` and the `api_keys` table: keys are hashed (`key_hash`) with a short prefix retained for fast lookup. The full key is shown only once at creation. Confirm:
   - GET `/auth/api-keys` returns prefix + label + dates, never the hash
   - The plaintext key is not written anywhere (logs, audit, error response)

9. **Pickaxe over git history.** `git log --all -S 'BEGIN PRIVATE KEY' -S 'sk-' -S 'JWT_SECRET=' --source --pretty=fuller` — find any commit that added or removed the literal string. A single touch is enough to require rotation.

## Report

- **Critical** — service-grade secret in git history; secret reachable from a `+page.svelte` / `$lib/*.ts` (non-server) path; `JWT_SECRET` defaults to a hardcoded string in production.
- **High** — env reference in a client-bundle path; encryption key fallback runs in production silently; integration token returned from a GET endpoint instead of `has_<x>` boolean.
- **Medium** — overscoped key (e.g. an integration token with write scope when only read is needed); floating action ref on a secrets-touching workflow.
- **Low** — undocumented env intent, missing `.env.example` entry, missing `sensitive = true` on a borderline value.

For each: the env var name + the file referencing it + what should change. **Never paste a found secret into the report.**

## Useful starting points

- `backend/CLAUDE.md` — the documented constraints on `JWT_SECRET` and `FLAKEY_ENCRYPTION_KEY`
- `backend/src/auth.ts` — JWT signing / verification + `requireAuth` middleware (the file owns both — there's no `backend/src/middleware/` directory)
- `backend/src/crypto.ts` — AES-256-GCM `encryptSecret` / `decryptSecret` / `rotateSecret`. The corresponding test is `backend/src/tests/crypto.test.ts` — useful as a reference for the contract
- `frontend/src/lib/auth.ts` — `bt_*` localStorage convention
- `frontend/src/lib/config.ts` — `API_URL` export
- `.github/workflows/*.yml` — every workflow
- `.env.example` files at every package level

## Delegate to

Use the `flakey-auditor` agent: `"Audit secret handling — server-only env vars, client-bundle leakage, encryption-key fallbacks, git-history exposure."` Read-only. Recommendations only — never paste a found key into the report.
