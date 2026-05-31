---
description: Run one, several, or all of the bug-hunting persona auditors (.claude/agents/persona-*.md). Each persona adopts a real-world point of view (new user, power user, admin, international user, accessibility, integrator, adversary, data subject, plus any project-specific domain personas) and writes findings to reviews/<persona>.md. Usage — `/persona admin`, `/persona integrator,adversary`, or `/persona all` (default).
---

Dispatch the persona auditors named in the argument, in parallel, and summarize
what each filed.

## Resolve the argument

`$ARGUMENTS` selects which personas to run:

- empty or `all` → the whole panel (every `.claude/agents/persona-*.md`).
- a comma/space-separated list of slugs → just those. Accept slugs with or
  without the `persona-` prefix (`admin`, `persona-admin` both resolve).
- if a slug doesn't match an existing `persona-*` agent, list the available
  personas and ask which was meant — don't guess.

Discover the live list with `ls .claude/agents/persona-*.md` so this stays
correct as project-specific domain personas are added (see
`.claude/personas/README.md` § "Domain packs").

## Procedure

1. **Spawn one agent per selected persona, in parallel** — all Agent tool calls
   in a single message. Use `subagent_type: "persona-<slug>"` and a prompt that
   says: *"Run your persona audit. Reconcile reviews/<persona>.md with HEAD per
   `.claude/personas/README.md` before writing — re-verify open findings, move
   landed fixes to Resolved, re-stamp the header. Then hunt for new findings.
   Report a one-line-per-finding summary back to me; the full writeup goes in
   your review file."*
2. Each persona is **read-only on app code** and writes only its own
   `reviews/<persona>.md` (git-ignored). They do not patch anything.
3. **Consolidate** the summaries each agent returns into one table — persona,
   counts by severity, and the headline finding. Don't re-paste the full
   reports; point at the files.

## Output shape

```
# Persona panel — <date>  (HEAD <short-sha>)

| Persona | Crit | High | Med | Low | Headline finding |
|---------|------|------|-----|-----|------------------|
| admin   | 0    | 1    | 1   | 0   | role gate is UI-only, endpoint callable directly |
| ...     |      |      |     |     |                  |

Full reports: reviews/persona-*.md

## Recommended fix order
1. [Critical] ...
2. ...
```

## Notes

- Read-only. The reports are the deliverable; do not edit app code from findings
  without asking the operator first.
- These reports are living documents — the reconcile-before-you-trust rule in
  `.claude/personas/README.md` binds every run and every hand-edit. A finding not
  re-verified against HEAD is a bug in the report.
- For a focused change, prefer running the single relevant persona over the whole
  panel.
