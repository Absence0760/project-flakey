# Persona audits

A **persona** is a read-only Claude subagent (`.claude/agents/persona-*.md`) that
adopts a specific real-world point of view — a brand-new user, an admin, an
international customer, an integrator, an attacker — and walks the app the way
that person would, looking for bugs, missing primitives, wrong assumptions, and
gaps that a generic code review never surfaces because it has no human stake.

Personas complement, not replace, the other reviewers:

- `code-reviewer` / `repo-security-auditor` ask *"is this code correct and safe?"*
- A persona asks *"does this app actually work for **me**, and would it embarrass
  me / lock me out / leak my data / let me cheat it?"*

These ship in `base` as a **generic panel** that applies to almost any app. They
do **not** know your stack — each persona discovers it first (reads `CLAUDE.md`,
`docs/STACK.md`, the route/handler layout, the data models) and then audits. Add
domain-specific personas per project (see "Domain packs" below).

## How to run one

These are agents. Run one by asking for it by name, e.g.

> run the `persona-new-user` audit
> run `persona-international-user` and `persona-adversary`

or run the whole panel with the `/persona` command. Each persona writes its
findings to `reviews/<persona-name>.md`. The whole `reviews/` folder is
git-ignored — local working docs, not the source of truth (see the rationale in
`.gitignore`); the same place the `flakey-auditor` area reports land.

## The output contract (every persona follows this)

### 1. Reconcile with reality *before* writing anything

This is the rule that keeps the reports trustworthy. On every run, a persona:

1. Captures the current commit: `git rev-parse --short HEAD`.
2. Reads its existing `reviews/<persona>.md` if one exists.
3. **Re-verifies every open finding against the code at HEAD.** For each one:
   - Still reproduces → keep it, refresh the `file:line` (line numbers drift).
   - Fixed since last run → move it to `## Resolved`, stamp the commit/date the
     fix landed (or "fixed by HEAD" if you can't pin it).
   - No longer applicable (feature removed, assumption changed) → delete it with
     a one-line note in `## Resolved` so the next run doesn't re-derive it.
4. Looks for *new* findings.
5. Rewrites the header stamp (commit + UTC date from `date -u`).

A finding asserted but not re-verified against current code is a bug in the
report. Stale findings are worse than none — they waste a fix cycle and erode
trust in the whole folder. **Never** copy a prior finding forward without opening
the file it cites.

This rule binds *any* session that touches a `reviews/*.md` file, not just the
persona agent — if you open one to act on a finding, confirm it still
reproduces at HEAD first.

### 2. File format

````markdown
---
persona: persona-new-user
last_reviewed_commit: 1a2b3c4
last_reviewed_at: 2026-01-01T00:00:00Z
---

> **Living document — reconcile before you trust.** Findings were verified at
> the commit above. Before acting on or citing any entry, re-verify it against
> the current code; a fix may have landed since. When you edit this file, follow
> the protocol in `.claude/personas/README.md` § "Reconcile with reality".

# persona-new-user — review

_One paragraph: who I am and what I came here to check._

## Open findings

### [High] path/to/file:42 — first-run flow dead-ends on an unverified email
- **What I tried:** <concrete steps / curl / click path>
- **What I expected:** <the correct behaviour>
- **What happened:** <the bug>
- **Why it matters to me (the persona):** <the human stake>
- **Invariant / rule:** <CLAUDE.md § ... if applicable>
- **Fix scope:** <file(s) that would change — I do not patch>

## Resolved
- [Med] ~~auth.ts:88 — ...~~ fixed by `abc1234` (2026-01-01).

## Out of scope / notes
- <assumptions, things I deliberately didn't test, follow-ups>
````

### 3. Severity rubric

- **Critical** — data loss, account/tenant cross-over, money moved wrongly, or a
  reportable compliance breach. Fix before next deploy.
- **High** — the persona cannot complete a core job, or the app shows a
  wrong-but-plausible result they'd act on.
- **Medium** — friction, a missing affordance, a defensible-but-wrong default.
- **Low** — cosmetic, wording, nice-to-have.

### 4. House rules

- **Read-only on app code.** A persona reports; it does not patch. The only file
  it writes is its own `reviews/<persona>.md`.
- No emojis, no preemptive abstractions in anything you write (see `CLAUDE.md`).
- Don't paste secrets, full card/account numbers, or government IDs into a report
  — identify the field by name and location.
- Prefer reproducible findings. If you can't confirm one, file it under "needs
  verification" and say exactly what you'd need.
- Distinguish *a real bug* from *a feature the app never claimed to have*. Both
  are worth recording, but label the second as a **gap**, not a **defect**.

## The generic panel

| Persona | Point of view |
|---|---|
| `persona-new-user` | First-run / onboarding — signup, empty states, error clarity, "what do I do now" |
| `persona-power-user` | Daily heavy user — bulk ops, keyboard, large data volume, pagination, speed |
| `persona-admin` | Operator — settings, RBAC, destructive actions, audit trail, tenant/org config |
| `persona-international-user` | i18n/l10n — currency, dates, numbers, timezones, RTL, address/phone formats |
| `persona-accessibility-user` | WCAG/keyboard/screen-reader/contrast/motion + responsive small-screen |
| `persona-integrator` | API/webhook consumer — auth, idempotency, rate limits, error contracts, versioning |
| `persona-adversary` | Attacker — authz/IDOR, injection, replay, enumeration, secret exposure |
| `persona-data-subject` | Privacy — data export, account deletion, consent, retention, PII in logs |

## Domain packs — adding personas for *this* app

The generic panel is deliberately stack-agnostic. Most apps also deserve
personas tied to their domain. Copy the closest generic `persona-*.md`, then:

1. Rewrite the frontmatter `name` (`persona-<slug>`) and `description`.
2. Rewrite the identity paragraph and the "what I care about" list in that
   persona's real voice and incentives.
3. List the concrete app surfaces this persona exercises, with file starting
   points, so the agent doesn't burn a turn rediscovering the layout.
4. Add a "known bug shapes for this domain" list — the failure modes this
   persona is uniquely positioned to catch.
5. Keep the output-contract pointer (this file). Don't restate the whole
   protocol inline — reference it.

**Worked example — a finance / accounts-payable app** (the shape this framework
was extracted from): `persona-approver` (approval limits, segregation of duties),
`persona-cfo` (sign-off thresholds, dashboard math), `persona-accountant`
(GL coding, 2/3-way match, 1099), `persona-card-processor` and
`persona-payment-processor` (webhook idempotency, rebate/FX math), `persona-supplier`
(portal isolation), plus jurisdiction packs `persona-usa-business` /
`persona-uk-business` / `persona-south-africa-business` (tax, bank rails, date
and currency conventions). Other domains: a marketplace gets buyer/seller/
dispute personas; a healthcare app gets patient/clinician/billing; a CMS gets
author/editor/anonymous-reader.

**For this repo (a CI-agnostic test-reporting dashboard)**, good domain personas
to add: a `persona-ci-engineer` wiring a reporter package into a pipeline
(reporter config, upload auth/API keys, retries, large artifact uploads), a
`persona-developer-triaging-flakes` (flaky-test detection accuracy, run history,
screenshot/snapshot diffing, noise vs signal), and a `persona-self-hoster`
(install/Helm/Terraform, upgrades, backups, multi-tenant isolation between orgs).

### Engineering-role pack (shipped in this repo)

Three personas that test the app from an engineering-craft point of view rather
than an end user's — the cross-cutting theme being *"a test dashboard that
misreports results is the worst bug it can have."*

| Persona | Point of view |
|---|---|
| `persona-sdet` | Builds automated suites against the app + wires the `@flakeytesting/*` reporters into CI — testability primitives (readiness signals, stable selectors, seedable state), result-ingestion idempotency, flake-detection accuracy |
| `persona-qa-engineer` | Functional + exploratory testing — end-to-end feature correctness, state transitions, edge-case data, and whether displayed counts/badges/status reconcile with the underlying rows |
| `persona-dev` | App developer triaging a red build — shortest path to root cause (failing test + stack trace + screenshot + history), deep-linkability, error-message quality, local-dev ergonomics |

Run any of them by name or via `/persona sdet,qa-engineer,dev` (the command
discovers them automatically).

### Operator / consumer / support pack (shipped in this repo)

Personas for the people who run the service, read it to make decisions, and
support it — beyond the engineers who test against it.

| Persona | Point of view |
|---|---|
| `persona-self-hoster` | Platform/SRE standing the app up — install, Terraform/ECS, migration safety on populated data, upgrades, backup/restore, secrets, infra-level cross-org isolation |
| `persona-engineering-manager` | Reads the dashboard's *trends* to decide — longitudinal correctness of flake-rate/pass-rate/suite-health rollups across time, teams, and tenants; exports reconcile with the screen |
| `persona-release-manager` | Gates ships on results — run completeness, real-vs-flaky distinction, and whether a run's status is a trustworthy go/no-go signal |
| `persona-support-engineer` | Fields customer tickets — reproduce an org's issue, audit-log trustworthiness, and legitimate cross-tenant read that's scoped + audited, not a privacy hole |

Run via `/persona self-hoster,engineering-manager,release-manager,support-engineer`
or by name.
