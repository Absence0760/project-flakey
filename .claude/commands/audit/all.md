---
description: Run the full audit sweep — security + invariants + health — in parallel
argument-hint: [security|invariants|health] (optional area filter)
---

Run the project's full audit sweep. By default, runs every audit; with an argument, runs the named subset.

## Areas

- **security** — `audit/auth`, `audit/multi-tenant`, `audit/storage-paths`, `audit/secrets`, `audit/xss`
- **invariants** — `audit/migrations`, `audit/live-flow`, `audit/reporters`
- **health** — `audit/deps`, `audit/infra`, `audit/docs-drift`

## Procedure

1. Decide which audits to run based on `$ARGUMENTS`:
   - No argument → all audits
   - `security` → security subset
   - `invariants` → invariants subset
   - `health` → health subset

2. **Spawn the right agent per audit area, in parallel.** Send all dispatches in a single message with multiple Agent tool calls so they actually run concurrently.
   - Security + invariants areas (`auth`, `multi-tenant`, `storage-paths`, `secrets`, `xss`, `migrations`, `live-flow`, `reporters`): each is a separate `flakey-auditor` invocation. Pass the audit area as the prompt's first sentence (e.g. `"Audit auth gating and tenantQuery enforcement."`) and the corresponding `.claude/commands/audit/<name>.md` body as the rest of the prompt.
   - `deps`: a single `general-purpose` agent with the `deps.md` prompt — the work is mostly running each tool in turn.
   - `infra`: a single `general-purpose` agent with the `infra.md` prompt — reads the `.tf` files plus the apply walkthrough.
   - `docs-drift`: an `Explore` agent (read-only, broad) with the `docs-drift.md` prompt.

3. **Consolidate findings** into a single report grouped by severity (Critical / High / Medium / Low), then by audit area. For each finding: file:line, what's wrong, the audit that found it.

4. **Recommend a fix order**, but don't apply fixes without explicit confirmation. Critical/High findings should be flagged with "fix this before next deploy"; Medium/Low can be batched.

## Output shape

```
# Audit report — <date>

## Critical (N)
- [audit/<area>] file:line — <one-line>
- ...

## High (N)
- ...

## Medium (N)
- ...

## Low (N)
- ...

## Clean
- audit/<area> — no findings

## Recommended order
1. ...
2. ...
```

## Notes

- This is read-only. Each sub-audit is read-only by default.
- The report is the deliverable; do not edit code based on findings without asking the user first.
- If an audit finds no issues, list it under `## Clean` — easier to spot regression on the next run.
- If you launch agents in parallel, do it in a single assistant message with multiple tool calls. A series of sequential single-agent messages defeats the purpose.
