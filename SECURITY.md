# Security policy

## Reporting a vulnerability

Email **security@flakey.io** (or, if that bounces, open a private security
advisory via GitHub: <https://github.com/Absence0760/project-flakey/security/advisories/new>).

Please include enough detail to reproduce the issue: affected route /
component, expected vs. actual behaviour, and a minimal proof-of-concept if
possible. We will acknowledge receipt within 3 business days and aim to ship
a fix or coordinated disclosure plan within 30 days for high / critical
severities.

Do not open a public GitHub issue for security findings — the embargo
window is what protects existing deployments while a patch ships.

## Scope

In scope: anything in this repository, the published `@flakeytesting/*`
npm packages, and the SaaS-managed deployment at `flakey.io`.

Out of scope: third-party integrations beyond their published APIs (Jira,
PagerDuty, Slack), social-engineering attempts on contributors, denial-of-
service attacks against the SaaS instance.

## Supported versions

Only the `main` branch and the most recent published `@flakeytesting/*`
package versions receive security fixes. Older releases will not be
back-patched.

## Hardening already in place

For context on what is already defended against (so you don't waste time
re-reporting it), see:

- `docs/architecture.md` § 4 (auth hardening: per-account lockout,
  bcrypt-bounded response time, refresh-token rotation, per-request
  org-membership re-validation).
- The `.github/workflows/security.yml`, `gitleaks.yml`, `scorecard.yml`,
  and `terraform.yml` workflows surface CodeQL / Trivy / Scorecard /
  gitleaks findings to the GitHub Security tab on every PR + weekly.
- The four trust boundaries documented in `CLAUDE.md` (auth gating,
  tenant isolation via Postgres RLS, server-only secret scoping, fail-
  closed defaults).
