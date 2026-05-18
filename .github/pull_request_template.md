## Summary

<!-- 1–3 sentences on what this PR does and why. -->

## Changes

<!-- Bulleted list of the user-visible or developer-visible changes. -->

-
-

## Surface touched

- [ ] Application code (`src/` once it lands)
- [ ] Database migrations
- [ ] Infrastructure (`infra/`)
- [ ] Operator scripts (`bin/`)
- [ ] CI / GitHub Actions (`.github/`)
- [ ] E2E tests (`tests-e2e/`)
- [ ] Docs only

## Money / data safety checklist

<!-- Tick what applies. Untick lines that genuinely don't apply, but
     don't delete the row — so the next reviewer can see you considered
     it. -->

- [ ] No new path moves money (or: the new path is idempotent and writes an audit row)
- [ ] No new query reads tenant-scoped data without scoping (or: the scoping helper is used)
- [ ] No new endpoint is mounted before the auth middleware
- [ ] No PII / banking data is logged or returned to unauthenticated callers
- [ ] No secret has a hardcoded fallback (`process.env.X || "..."`)
- [ ] Money columns / variables use a fixed-precision type, not `float`/`number`

## Test plan

<!-- How this was verified. Delete rows that don't apply. -->

- [ ] Unit tests pass locally
- [ ] Integration tests pass locally
- [ ] Manual walkthrough on the affected surface (describe below)

<!-- Manual walkthrough notes: -->
