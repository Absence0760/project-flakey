---
description: Sweep the backend's logging and error-handling paths for PII or secrets leaking into log lines or HTTP responses (SOC 2 / GovRAMP)
---

Audit every log call and error-response path in `backend/src/` for personal data and secrets that must never be written to stdout/stderr or returned to a client. Under SOC 2 (all five TSCs) and GovRAMP, a token or an email in a log line is a real finding, not a nit.

## Goal

This backend logs to stdout/stderr (captured by the ECS Fargate task → CloudWatch); there is no structured logger — it's all ad-hoc `console.error`/`console.log` with one helper, `safeLog()` in `backend/src/log.ts`, which strips CR/LF for log-injection (CWE-117) but does **not** redact content. So whatever a route interpolates into a `console.*` call lands verbatim in CloudWatch, and whatever a handler puts in `res.json({ error })` lands in the client's browser. This audit answers one question: does any of that carry PII (emails, names) or a secret (passwords, JWTs, API keys, refresh tokens, decrypted Jira/PagerDuty credentials, the `FLAKEY_ENCRYPTION_KEY`)?

This is distinct from the adjacent audits — **do not re-report their findings here**:

- `/audit/secrets` covers secrets leaking into the *client bundle / public assets / git*. This audit is server-side logs and HTTP error bodies only.
- `/audit/auth` covers `requireAuth` gating and tenant scoping. Don't re-litigate whether a route is authed; only flag what its *log lines and error responses* expose.
- `/audit/multi-tenant` covers RLS. A cross-tenant read is their finding; a tenant's data appearing in a shared log stream is yours.

## What to check

1. **Secrets in `console.*` (Critical/High).** Grep `backend/src/**/*.ts` for `console.(log|error|warn)` and inspect every interpolated value. The seed (`backend/src/seed.ts`) intentionally prints credentials and the demo API key (`fk_demoadmin…`, line ~1654) and the invite token (line ~1733) — that's a dev-only script, note it but don't treat seed output as a prod leak. Real concerns: any path that logs `password`, `password_hash`, a signed JWT, a `fk_`-prefixed API key, a refresh token (`jti`/`flakey_refresh`), or the value returned by `decryptSecret()` (`backend/src/crypto.ts`). The integration code is the prime suspect — `backend/src/integrations/jira.ts` and `pagerduty.ts` call `decryptSecret(row.jira_api_token)` / `decryptSecret(row.pagerduty_integration_key)`; confirm the decrypted value is never the thing being logged.

2. **The global error handler — does it exist, and does it leak? (Critical/High).** There is currently **no** Express error-handling middleware (`app.use((err, req, res, next) => …)`) registered in `backend/src/index.ts` — every route does its own `try/catch`. Most return a generic `{ error: "Internal server error" }` (good), but several return the raw exception message to the client: `backend/src/routes/jira.ts:163` (`res.status(500).json({ error: (err as Error).message })`), `routes/releases.ts:787` and `:1612`, `routes/analyze.ts:22`. A raw `err.message` can carry a Postgres error echoing a user-supplied parameter, a connection string, or an upstream API body. Flag each; recommend a single error-handler that logs the detail server-side (via `safeLog`) and returns a generic message + a correlation id to the client. Confirm no handler ever puts `err.stack` into the response body in production.

3. **Auth-path logging (High).** `backend/src/auth.ts` and `backend/src/routes/auth.ts` are where credentials flow. Check that `POST /auth/login` (`routes/auth.ts:216`), `/register` (`:295`), and the refresh path never log `req.body` (which holds `password`), the bcrypt hash, or the issued token. Critically, the login path is deliberately hardened against account enumeration — unknown email and wrong password are timing-indistinguishable and both return `Invalid email or password`. **Flag any log line that would reveal whether an email exists** (e.g. `console.error("no user for", email)` on the unknown-email branch vs. a different log on the wrong-password branch) — that re-opens the enumeration oracle through the log stream even though the HTTP response closed it.

4. **Integration error bodies (High/Medium).** `backend/src/integrations/jira.ts` logs the raw upstream response body on failure: `console.error(\`Jira create failed: ${res.status}\`, body)` at lines 89, 225, 257, 294 — and a comment there notes Jira "sometimes include[s] the request payload back." That payload can echo the issue title/description (test names, failure output) and, worse, reflected auth context. Judge whether the logged `body` can contain a credential or customer data; recommend truncation/redaction. Same pattern in `backend/src/git-providers/index.ts` (commit-status / PR-comment errors).

5. **Unredacted request dumps (Medium).** Grep for `req.body`, `req.headers`, `req.query`, and `JSON.stringify(req…)` reaching a `console.*`. `req.headers` carries `Authorization: Bearer <jwt|fk_…>` and the `Cookie` header (`flakey_token`/`flakey_refresh`); `req.body` on auth/integration routes carries passwords and API tokens. Any handler that logs a whole request object is a Medium at least, High if it's on an auth/integration route.

6. **Error-detail columns echoed back (Medium).** The schema stores `tests.error_message` and `tests.error_stack` (from `routes/runs.ts:104`, `routes/uploads.ts:264`, and the normalizers in `backend/src/normalizers/*.ts`). These are *expected* in API responses — they're the product. But flag if a 500 handler blindly serializes a DB row that includes `error_stack` into a generic error body, or logs a full row dump where the stack carries file paths / env detail.

7. **Structured-vs-ad-hoc consistency (Low).** There is no logger abstraction — every call is a bare `console.*` with a hand-written prefix (`"[api-key]"`, `"POST /auth/login error:"`, `"Webhook dispatch error:"`). `safeLog()` is applied in only one place (`routes/runs.ts:150`). Note the inconsistency as defence-in-depth: a single redaction-aware logging helper (allow-list of safe fields, mandatory `safeLog`) would make leaks structurally hard instead of relying on each author remembering. Don't over-flag every un-`safeLog`'d call as High — rank by whether the interpolated value is actually sensitive.

8. **Authorization / cookie redaction in request logging (Low → Medium if present).** There is currently no `morgan`/request-logging middleware. If one is added (or you find one), confirm it redacts the `Authorization` header and `Cookie`. Flag the *absence of a redaction policy* as a Low defence-in-depth item so it's decided deliberately before request logging ever ships.

## Report

Group by severity. For this audit the tiers mean:

- **Critical / High** — a secret or token written to a log line (CloudWatch retains it); a decrypted integration credential or the encryption key in any log; a stack trace, raw `err.message`, or PII returned in a production HTTP response body; a log line that re-opens the login email-enumeration oracle.
- **Medium** — PII (email, name) or an unredacted request dump (`req.body`/`req.headers`) in a debug/error log; a logged upstream-integration body that can carry customer data or reflected credentials.
- **Low** — inconsistent / ad-hoc logging (no shared redaction-aware helper); missing request-log redaction policy; defence-in-depth hardening.

For each finding: the `file:line`, what sensitive field/value leaks (name the field — `password`, `jira_api_token`, `flakey_token` cookie, `users.email` — **never paste a real value or secret**), the sink (CloudWatch log vs. HTTP response), and the smallest fix (route through `safeLog` + an allow-list, redact the field, replace `err.message` with a generic body + correlation id, or add the central error handler).

## Useful starting points

- `backend/src/index.ts` — confirm the missing global error handler; the boot-time `console.error`/`console.warn` guards; no request logger
- `backend/src/log.ts` — `safeLog()`: strips CR/LF, does NOT redact content (understand its actual scope)
- `backend/src/auth.ts` — `requireAuth`, `verifyApiKey` (the `[api-key]` log), token signing
- `backend/src/routes/auth.ts` — login/register/refresh `catch` blocks and the enumeration-hardening design
- `backend/src/integrations/jira.ts`, `backend/src/integrations/pagerduty.ts` — `decryptSecret(...)` + the logged upstream `body`
- `backend/src/git-providers/index.ts` — commit-status / PR-comment error logging
- `backend/src/routes/jira.ts:163`, `backend/src/routes/releases.ts:787`/`:1612`, `backend/src/routes/analyze.ts:22` — raw `err.message` in the response
- `backend/src/crypto.ts` — `decryptSecret` (what must never reach a log)
- grep baseline: `grep -rnE 'console\.(log|error|warn)' backend/src --include='*.ts' | grep -v tests/`

## Delegate to

Use the `compliance-auditor` agent (it knows where PII lives in this codebase): `"Audit logs and error responses for PII and secret leakage. Write the report to reviews/pii-in-logs.md."` Read-only on the codebase — it reports, it does not patch. Identify every leak by field/column name; **never paste a real value, token, or secret** into the report. The deliverable is the findings report at **`reviews/pii-in-logs.md`**.
