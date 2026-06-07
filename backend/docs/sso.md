# Enterprise SSO (Phase 14)

Status by slice:

| Slice | What | Status |
|---|---|---|
| 1 | OIDC login (Authorization-Code + PKCE) | **Built** — flag-gated, awaiting CISO sign-off before enable |
| 2 | SAML login (POST binding) | **Built** — flag-gated, awaiting CISO sign-off before enable |
| 3 | SCIM 2.0 provisioning | **Built** — flag-gated, awaiting CISO sign-off before enable |

> ⚠️ **Security gate.** SSO is a GovRAMP-scoped authentication control. It ships
> **off** (`FLAKEY_SSO_ENABLED` unset) and must not be enabled in a regulated
> environment until the CISO / Security Analyst signs off. The adversarial
> review against the proposal's eight trust boundaries lives in
> `reviews/sso-security-review.md` — it is *advisory input for* that human
> sign-off, not a substitute for it. See
> [docs/proposals/phase-14-sso.md](../../docs/proposals/phase-14-sso.md).

## Design principle

SSO is **additive**: it is a third way to *mint the existing Flakey session*,
not a new session primitive. After the callback the world is unchanged — same
JWT, same `requireAuth`, same per-request `org_members` re-check, same RLS. An
IdP claim never grants access on its own; org access is still the `org_members`
row + RLS, and a role claim can only reach a role the admin placed in `role_map`.

## Slice 1 — OIDC

### Enabling it

1. Set `FLAKEY_SSO_ENABLED=true` on the backend.
2. Set `PUBLIC_API_URL` to this backend's public base URL (default
   `http://localhost:3000` in dev). The IdP redirect URI is
   `<PUBLIC_API_URL>/auth/sso/callback` — register it at the IdP.
3. As an org owner/admin, configure the IdP at **Settings → Single sign-on**
   (or `PUT /sso/config`): issuer, client id, client secret, JIT policy,
   allowed email domains, default role, role claim, and role map.

### Flow

```
GET /auth/sso/:orgSlug/start
  → resolve org + load enabled OIDC config (fail closed if missing)
  → PKCE (S256) + state + nonce, bound into a signed httpOnly tx cookie
  → 302 to the IdP authorize endpoint

GET /auth/sso/callback?code=&state=
  → verify state == tx.state (CSRF), exchange code (PKCE + client secret)
  → verify the ID token against the IdP JWKS: signature + iss + aud + exp + nonce
  → resolve/JIT-provision the user, map role, mint the existing Flakey JWT+refresh
  → 302 to <FRONTEND_URL>/sso/complete

GET /auth/sso/session   (SPA handoff — same-origin only)
  → returns the cookie session as JSON so the SPA populates localStorage
```

### Tables (migration `055_sso_oidc.sql`)

- `org_sso_configs` — one row per org. Client secret is AES-256-GCM encrypted
  via `FLAKEY_ENCRYPTION_KEY` (same path as Jira/PagerDuty); the API never
  returns it, only `hasClientSecret`. RLS-isolated per org.
- `sso_identities` — `(org_id, protocol, external_id) → user_id`, so re-login is
  deterministic and linking is recorded. RLS-isolated per org.

### Invariants worth keeping in mind when editing

- **Token validation is non-negotiable.** `verifyIdToken` rejects on any of
  signature / `iss` / `aud` / `exp` / `nonce` mismatch. Never add a fallback
  that accepts an unverified token.
- **Fail closed.** A missing/half/disabled config, a discovery failure, or a
  state mismatch refuses the login (redirect to `/login?sso_error=…`); it never
  drops to a weaker path.
- **Role claims cannot widen access.** `mapRole` only honours values present in
  the admin-configured `role_map`; unmapped values fall back to `default_role`.
- **`enforced` ("SSO required") uses the AWS-console-MFA model, not a hard block.**
  Password login still *succeeds* for an enforced org, but the session is minted
  restricted (`ssoRequired`) and `requireAuth` clamps it to `GET /auth/me` until
  the user re-authenticates through their IdP (which mints an unrestricted `sso`
  session). `signToken`/`signRefreshToken` carry `sso`; `/auth/refresh` preserves
  it so an SSO session is never downgraded to restricted. The login/switch-org
  responses return `ssoRequired` + `orgSlug` so the SPA redirects to the IdP.
  Known limitation: an SSO-established session satisfies enforcement in *any* org
  it switches into (no per-org SSO-auth tracking) — acceptable for v1, documented.

## Slice 2 — SAML

SP-initiated, HTTP-POST binding, via the vetted `@node-saml/node-saml` (we do
not hand-roll XML signature handling).

- **ACS URL** to register at the IdP: `<PUBLIC_API_URL>/auth/sso/saml/acs`.
  Set the SP entity ID to your configured `samlIssuer` (or the ACS URL).
- Configure at **Settings → Single sign-on** (protocol = SAML 2.0): IdP SSO URL,
  IdP signing certificate (PEM or base64 body), optional SP entity ID / audience,
  plus the same JIT / domain / role-claim / role-map controls as OIDC. The role
  claim is the SAML *attribute name* carrying roles.

What's validated, in order, on the ACS:

1. **RelayState** — a signed JWT (`state` + org + return path) we issued at
   `/start`. Survives the IdP's cross-site POST (a cookie wouldn't, SameSite).
2. **Assertion signature + conditions + audience** — by node-saml against the
   configured IdP cert (`wantAssertionsSigned`, NotBefore/NotOnOrAfter + clock
   skew, audience). Unsigned / alg-stripped assertions are rejected.
3. **InResponseTo binding** — the assertion's `InResponseTo` must equal the
   AuthnRequest ID we persisted (org-scoped, consumed once) at `/start`.
4. **One-time use** — the assertion XML hash is recorded in `sso_saml_replay`
   (org-scoped); a replay collides and is refused.

Only then is the existing Flakey session minted. Tables: `sso_saml_requests`,
`sso_saml_replay` (migration `056_sso_saml.sql`), both RLS-isolated per org.

> The positive SAML login path (a real signed assertion) is proven via the
> Keycloak app-facing e2e — the same status as OIDC's positive callback. The
> smoke suite covers config round-trip, the real `/start` redirect, and
> fail-closed rejection of unsigned/forged input.

## Slice 3 — SCIM 2.0 provisioning

`/scim/v2/{Users,Groups}` (RFC 7643/7644), authenticated by a **per-org bearer
token** (not a user session). Validated against the committed mock target
(`infra/scim-target/server.mjs`) — the working client contract.

- **Enable / token**: an owner/admin issues a token at **Settings → Single
  sign-on → SCIM** (or `POST /sso/scim/token`). The raw token is shown once;
  only its bcrypt hash + a prefix are stored. The IdP's SCIM base URL is
  `<PUBLIC_API_URL>/scim/v2`. `DELETE /sso/scim/token` disables SCIM.
- **Users**: create → finds/creates the Flakey user + grants org membership
  (`default_role`). `active:false` (PATCH/PUT) or `DELETE` → **removes the org
  membership** (so `requireAuth`'s per-request re-read 401s the access token on
  the next call) **and stamps `users.sessions_revoked_at`** (migration 058) so a
  still-valid refresh token can't outlive deactivation by minting a fresh
  personal-org session at `/auth/refresh`. Together that's the GovRAMP
  "deactivate immediately" control. Filter `userName eq "…"` powers the IdP's
  pre-create existence check.
- **Groups**: a group whose `displayName` maps via the org's `role_map` to a
  Flakey role sets that role on its members. Unmapped groups are a no-op —
  cannot widen access.
- **Isolation**: every SCIM resource is org-scoped via `tenantQuery` + RLS;
  one org's token can't see or fetch another org's users (smoke-tested).

Tables: `scim_users`, `scim_groups` (migration `057_sso_scim.sql`), RLS per org.
Token lookup is a SECURITY DEFINER prefix function (mirrors `lookup_api_key`).

### Local testing

- Unit: `src/tests/sso.unit.test.ts` (role mapping, PKCE).
- Smoke: `src/tests/sso.smoke.test.ts` (kill switch, fail-closed, config
  round-trip with no secret leak, real PKCE authorize redirect against a mock IdP).
- IdP-contract e2e (Keycloak): `frontend/tests-e2e/sso/keycloak-oidc.spec.ts`
  via `pnpm idp:up` + `pnpm --filter frontend test:e2e:sso`.
- SCIM smoke: `src/tests/scim.smoke.test.ts` (token auth, full Users lifecycle
  incl. deactivation→membership-removal, per-org RLS isolation). The
  Authentik→target loop (`frontend/tests-e2e/sso/authentik-scim.spec.ts`) is the
  IdP-side proof; the real endpoint satisfies the same client behavior.
