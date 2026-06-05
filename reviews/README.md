# `reviews/` — audit & review working notes

This directory holds the findings from code audits and reviews — the output of
the `/audit/*` slash commands, the `code-reviewer` agent, persona hunts
(`/persona`), `/fanout-review`, and ad-hoc deep-dive reviews.

**It is gitignored.** Everything here is a local working note except this
`README.md` (see the `.gitignore` rule `reviews/*` + `!reviews/README.md`).
Findings are a point-in-time snapshot of the code; they go stale fast and
should not live in version control.

## Where findings go

- **All audit / review findings land here**, one Markdown file per audit area
  or run. Don't scatter findings into chat-only output or into `docs/` (docs
  describe how things *are*, not a list of open bugs).
- **Naming convention** (every `.claude/commands/audit/*` and the auditor /
  persona agents write here):
  - `/audit/<name>` and the auditor agents → `reviews/<name>.md`
    (e.g. `reviews/auth.md`, `reviews/multi-tenant.md`)
  - persona hunts → `reviews/persona-<name>.md`
    (e.g. `reviews/persona-admin.md`)
- Group related runs in a subfolder (`reviews/<audit-name>/...`) when one audit
  spans several areas.

## Lifecycle — mark progress in the file

Each finding carries a status marker so a file always shows what's left:

- `[ ]` open — not yet addressed
- `[x]` fixed — resolved; append the commit hash, e.g. `[x] (a1b2c3d)`
- `[~]` deferred — won't fix now; **state why** and where it's tracked

Rules:

1. **When you start fixing an audit, update its file as you go** — flip each
   finding to `[x]` in the *same commit* that lands the fix (mirrors the repo's
   one-piece-one-commit, path-scoped cadence). Don't fix five things and leave
   the file showing five open items.
2. **Deferred items stay in the file** with `[~]` + a reason — never silently
   drop a finding. If it's a durable bug/feature that outlives the audit,
   promote it to the roadmap / a Jira ticket and link it from the `[~]` line.
3. **Delete a file once it's spent** — when every finding is `[x]` or `[~]`
   (and the deferred ones are tracked elsewhere), or when the code has moved on
   far enough that the findings reference structures that no longer exist, the
   file is stale. Delete it; the git history of the *fixes* is the record, not
   the audit note.

## Why local-only

These notes name file:line locations and describe bugs; committing them means
they rot the moment the code changes (a reorg alone invalidates every path).
Keeping them out of git means a stale audit can never masquerade as current
truth, and the signal that matters — the fix and its test — lives in the
commit that closed the finding.
