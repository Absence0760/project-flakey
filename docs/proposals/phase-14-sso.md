# Proposal: Enterprise SSO — OIDC / SAML login + SCIM provisioning

**Status:** Proposed — not yet implemented. **Requires CISO / Security Analyst sign-off before build** (SOC 2 / GovRAMP-scoped auth control).
**Area:** `backend/` auth (`src/routes/auth.ts`, `requireAuth`, `org_members`), `frontend/` login + org settings, a new `idp` local-dev dependency (Keycloak).
**Effort:** Large. Land in slices (OIDC → SAML → SCIM), each behind a flag, each with its own review.

---

## Summary

Add IdP-backed single sign-on (OIDC and SAML) plus automated user/role
provisioning (SCIM 2.0) so enterprise and GovRAMP buyers can onboard against
their own directory (Entra ID, Okta, etc.) instead of email/password. This is
the single biggest gap for that segment (roadmap Phase 14).

Today auth is **JWT + API keys + email/password only** (`backend/src/routes/auth.ts`;
`bcryptjs` + `jsonwebtoken`, no `passport`/`saml`/`oidc` deps — confirmed by grep).
SSO is **purely additive**: it becomes a third way to *mint the same session* the
app already issues. The post-login world is unchanged — same JWT, same
`requireAuth`, same `org_members` re-check, same Postgres RLS. That containment
is the whole design principle: **SSO changes how a session is created, not what a
session can do.**

A local Keycloak (`pnpm idp:up`) already lets us prototype and e2e-test the flow
with zero online signup — see [Local dev + testing](#local-dev--testing) below;
the scaffolding (compose `idp` profile, seeded realm, passing Playwright proof)
is already committed.

## Motivation

- Enterprise / GovRAMP buyers mandate IdP login + lifecycle provisioning against
  their directory; email/password is a non-starter in procurement.
- We already have the *authorization* model (org roles, RLS, audit log,
  member re-validation). What's missing is *authentication* federation and
  *provisioning* — both bolt onto the existing model rather than replacing it.

## Scope (land in slices)

### Slice 1 — OIDC login (smallest viable; do first)
- Per-org IdP config: `issuer`, `client_id`, `client_secret` (encrypted via the
  existing `FLAKEY_ENCRYPTION_KEY` path used for Jira/PagerDuty secrets),
  allowed email domain(s), and a **role-claim → org-role map**
  (`flakey_roles` claim → `owner`/`admin`/`viewer`). New table `org_sso_configs`
  (org-scoped, **RLS in the same migration** per guard rail 11).
- Backend Authorization-Code + PKCE flow: `GET /auth/sso/:orgSlug/start` →
  redirect to IdP; `GET /auth/sso/callback` → validate `state`/`nonce`, exchange
  code, **verify the ID token signature against the IdP JWKS** (`iss`/`aud`/`exp`),
  resolve/JIT-provision the user, then mint the **existing** Flakey JWT + refresh
  token. No new session primitive.
- Frontend: an org-aware "Sign in with SSO" entry on the login page.

### Slice 2 — SAML login
- Same callback-mints-existing-session shape, SAML POST binding. Adds an XML/
  signature-validation dependency — the highest-risk surface (XML signature
  wrapping, canonicalization). Use a vetted library; do not hand-roll.

### Slice 3 — SCIM 2.0 provisioning
- `/scim/v2/Users` + `/scim/v2/Groups` (RFC 7644), bearer-token-authenticated
  per org, so the IdP can create / update / **deactivate** users and push group→
  role changes. Deactivation must immediately revoke access — it rides the
  existing `requireAuth` `org_members` re-check + refresh-token revocation.

## Trust boundaries & invariants (the review surface)

This is where the CISO review should focus. SSO must preserve every existing
invariant in `docs/architecture.md` § 4:

1. **Session containment.** The callback mints the *same* JWT the app issues
   today. SSO adds no claim that grants access on its own — org access is still
   the `org_members` row + RLS. A forged/over-scoped IdP claim cannot widen
   access beyond the role mapping the org admin configured.
2. **RLS unchanged.** All SSO-provisioned data (`org_sso_configs`, SCIM-created
   members) is org-scoped via `tenantQuery`/`tenantTransaction`; every new table
   ships an RLS policy in its migration. The app keeps connecting as
   non-superuser `flakey_app`.
3. **Token validation is non-negotiable.** ID tokens verified against JWKS
   (signature + `iss` + `aud` + `exp` + `nonce`); SAML assertions signature- and
   condition-validated. Reject unsigned/`alg:none`.
4. **CSRF/replay.** `state` + `nonce` (OIDC) and `InResponseTo` + one-time
   assertion IDs (SAML) are mandatory.
5. **Member revocation stays instant.** `requireAuth` already re-reads
   `org_members` per request; SCIM deactivation + SAML/OIDC SLO must remove the
   membership / revoke refresh tokens so access ends on the next request, not at
   JWT expiry.
6. **Secrets.** IdP client secrets + SCIM bearer tokens are encrypted at rest via
   the existing key path; never logged (ties to the PII-in-logs control).
7. **Audit.** Every SSO login, JIT provision, role change, and SCIM mutation is
   written to the existing audit log (SOC 2 / GovRAMP logging control).
8. **Fail closed.** Misconfigured/unreachable IdP → login is refused with a clear
   error; it never silently falls back to a weaker path.

## Local dev + testing

Per guard rail 7 (local-first), the IdP ships with a local equivalent and a code
default so `pnpm dev` never needs a real SaaS IdP. **Already committed:**

- **`pnpm idp:up` / `idp:down` / `idp:reset`** — Keycloak on `:8081` behind the
  compose `idp` profile (opt-in; stock auth needs no IdP).
- **Seeded realm** `infra/keycloak/flakey-realm.json` — realm `flakey`, OIDC
  client `flakey-web`, users `sso.admin@example.com` / `sso.viewer@example.com`
  (password `ssopassword`), and a `flakey_roles` realm-role claim mapper. Imported
  deterministically on boot — no manual console clicking, no signup.
- **e2e proof** `frontend/tests-e2e/sso/keycloak-oidc.spec.ts` (run:
  `pnpm idp:up` then `cd frontend && pnpm test:e2e:sso`) — drives a full
  Authorization-Code + PKCE flow through Keycloak's hosted login UI headlessly:
  fills the form, follows the redirect, exchanges the code, and asserts the token
  carries `email` + `flakey_roles: ["flakey-admin"]`. A negative spec asserts bad
  credentials are rejected with no code issued. **Both pass today.**

This proves the IdP contract and the browser automation independent of any app
wiring. When SSO is built, the *app-facing* SSO specs move under the main e2e
config (they need the app up) with an SSO storage-state setup; this Keycloak-only
config stays as the IdP-contract proof.

**SCIM note:** Keycloak does OIDC + SAML out of the box; SCIM *as a provider*
(pushing to Flakey) needs a Keycloak SCIM extension or a switch to **Authentik**
(built-in SCIM). Decide the local SCIM-test IdP when Slice 3 is scheduled.

## Open questions for security review

- IdP config scope: per-org (multi-tenant SaaS) vs. one instance-wide IdP for
  single-tenant self-hosters? (Proposed: per-org, instance default optional.)
- JIT provisioning policy: auto-create members on first SSO login, or require a
  pre-existing invite? (GovRAMP likely wants explicit provisioning / SCIM-only.)
- Domain-capture / account-linking: can an SSO login claim an existing
  email/password account? (Proposed: only with verified email + explicit link.)
- Do we disable email/password per-org once SSO is enforced? (Likely yes for
  GovRAMP tenants — "SSO required" flag.)
- SAML library + supply-chain review; SCIM bearer-token rotation story.

## Out of scope

- Building any of the three slices before sign-off.
- Replacing the existing JWT/API-key/email-password auth (SSO is additive).
- A hosted IdP — local Keycloak covers dev/test; production points at the
  customer's directory.
