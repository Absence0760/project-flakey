# Security policy

## Reporting a vulnerability

This policy applies to the upstream [Flakey](https://github.com/Absence0760/project-flakey)
project. If you've found an issue here, please report it via the
**[GitHub security advisory form](https://github.com/Absence0760/project-flakey/security/advisories/new)**.

Please include enough detail to reproduce the issue: affected route /
component, expected vs. actual behaviour, and a minimal proof-of-concept if
possible. We will acknowledge receipt within 3 business days and aim to ship
a fix or coordinated disclosure plan within 30 days for high / critical
severities.

Do not open a public GitHub issue for security findings — the embargo
window is what protects existing deployments while a patch ships.

> **Forking this repo for self-hosting?** Replace this section with your
> own intake address (e.g. `security@your-domain.example`) and change the
> advisory link to your fork's `…/security/advisories/new` page. Reports
> about *your* deployment should not land in the upstream tracker.

## Scope

In scope: anything in this repository and the published `@flakeytesting/*`
npm packages.

Out of scope:

- Third-party integrations beyond their published APIs (Jira, PagerDuty,
  Slack).
- Issues that only reproduce against a fork's customisations or a self-
  hoster's deployment — report those to the fork's maintainer.
- Social-engineering attempts on contributors.
- Denial-of-service attacks against any specific deployment (capacity is
  an operator concern, not a code concern).

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
