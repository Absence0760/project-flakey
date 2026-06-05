---
description: Run the full audit sweep — security + invariants + database + compliance + health — in parallel
argument-hint: [security|invariants|database|compliance|health] (optional area filter)
---

Run the project's full audit sweep. By default, runs every audit; with an argument, runs the named subset.

## Areas

- **security** — `audit/auth`, `audit/multi-tenant`, `audit/storage-paths`, `audit/secrets`, `audit/xss`
- **invariants** — `audit/migrations`, `audit/live-flow`, `audit/reporters`, `audit/api-contract`
- **database** — `audit/schema-design`, `audit/db-performance`, `audit/migration-locks`, `audit/seed-integrity`
- **compliance** — `audit/accessibility`, `audit/pii-in-logs`
- **health** — `audit/deps`, `audit/licenses`, `audit/infra`, `audit/docs-drift`

Not part of the sweep (they act, not just report — invoke deliberately): `/flake-doctor`, `/endpoint-inventory`.

## Procedure

1. Decide which audits to run based on `$ARGUMENTS`:
   - No argument → all audits
   - `security` → security subset
   - `invariants` → invariants subset
   - `database` → database subset
   - `compliance` → compliance subset
   - `health` → health subset

2. **Spawn the right agent per audit area, in parallel.** Send all dispatches in a single message with multiple Agent tool calls so they actually run concurrently. Each agent writes its own report to `reviews/<area>.md` and returns a short summary.
   - Security + invariants + database areas (`auth`, `multi-tenant`, `storage-paths`, `secrets`, `xss`, `migrations`, `live-flow`, `reporters`, `api-contract`, `schema-design`, `db-performance`, `migration-locks`, `seed-integrity`): each is a separate `flakey-auditor` invocation. Pass the audit area + output path as the prompt's first sentence (e.g. `"Audit auth gating and tenantQuery enforcement. Write the report to reviews/auth.md."`) and the corresponding `.claude/commands/audit/<name>.md` body as the rest of the prompt.
   - Compliance areas (`accessibility`, `pii-in-logs`): each a `compliance-auditor` invocation with the matching `.md` prompt → writes `reviews/<area>.md`.
   - `deps`, `licenses`, `infra`: each a single `general-purpose` agent with the matching `.md` prompt → writes `reviews/<area>.md`.
   - `docs-drift`: an `Explore` agent (read-only, broad) with the `docs-drift.md` prompt; it returns the report and **you** write it to `reviews/docs-drift.md` (Explore can't write files).

3. **Consolidate findings** into a single summary grouped by severity (Critical / High / Medium / Low), then by audit area. For each finding: file:line, what's wrong, the audit that found it. The per-area detail already lives in each `reviews/<area>.md`; also write this consolidated summary to **`reviews/_audit-summary.md`** (the `_` prefix sorts it to the top of the folder) so the whole sweep is recoverable across sessions.

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

- This is read-only on the codebase. Each sub-audit writes only its `reviews/<area>.md` report (plus the consolidated `reviews/_audit-summary.md`); none edit code.
- The reports are the deliverable; do not edit code based on findings without asking the user first.
- Reports persist in `reviews/` (gitignored except its README), so a long sweep survives across sessions — you can pick up `reviews/_audit-summary.md` later. Re-running an area overwrites its file.
- If an audit finds no issues, list it under `## Clean` — easier to spot regression on the next run.
- If you launch agents in parallel, do it in a single assistant message with multiple tool calls. A series of sequential single-agent messages defeats the purpose.
