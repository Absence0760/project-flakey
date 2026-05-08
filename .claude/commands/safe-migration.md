---
description: Add or land a Postgres migration with the migration-coordinator agent in the loop. Applies locally, verifies RLS, surfaces type-sync edits across backend/src/types.ts and frontend/src/lib/api.ts (project-flakey has no codegen), proposes smoke tests, flags doc updates.
argument-hint: <migration slug or path>
---

Run the new-migration workflow for `$ARGUMENTS`. Either author + coordinate the migration, or coordinate one the user has already drafted.

## When to use this command

**Right fit:**

- About to add a new file under `backend/migrations/`
- Just finished drafting a migration and want to verify before committing
- Modifying an unmerged migration and want to re-run the coordination steps

**Wrong fit — refuse:**

- Already-merged migrations (don't try to coordinate history)
- Pure data-backfill SQL with no schema change (run as a one-off, not a numbered migration)

## What this command does

It is **not** the per-change reviewer (`/safe-edit`). It is the per-migration workflow that catches drift the reviewer can't easily see — RLS coverage on new tenant tables, manual type-sync between SQL and TS (no codegen exists for project-flakey), idempotency markers, and which smoke-test files need to grow.

The actual work is done by the `migration-coordinator` agent. This command is the orchestrator: figure out which migration we're talking about, invoke the agent, then prompt the user for the follow-up edits.

## Procedure

### 1. Resolve the migration

If `$ARGUMENTS` is:

- A **path** under `backend/migrations/` → use that file directly.
- A **slug** without a number → find the highest-numbered existing migration in `backend/migrations/` and propose `NNN_<slug>.sql` for the next slot. If the file doesn't exist yet, ask the user to draft it first (or prompt them with a starter template) — do not invent SQL on their behalf.
- **Empty** → run `git status` + `ls backend/migrations/` and identify the new or modified `.sql` file. If there's no candidate, abort with "no migration to coordinate."

### 2. Spawn the migration-coordinator agent

Once you have a concrete file path, invoke the agent with the prompt:

> "Coordinate the migration at `backend/migrations/<file>`. Apply locally via ./backend/migrate.sh, verify RLS coverage on any new tenant table, surface the manual type-sync edits needed across backend/src/types.ts and frontend/src/lib/api.ts, propose smoke-test additions, and flag doc updates. Output the format from your spec."

### 3. Relay the agent's report

The agent's output is the deliverable — relay it verbatim to the user. Do not summarise away the file paths or the proposed field signatures; those are the actionable bits.

### 4. Offer to apply the follow-up edits

After the agent returns, ask the user one focused question:

> "Want me to apply the type-sync edits to backend/src/types.ts and frontend/src/lib/api.ts now? [The agent proposed: ...]"

If yes, apply only the proposed changes (no scope creep into adjacent interfaces). If no, end the turn — the user will handle it.

Same offer for the smoke-test stubs and doc updates, in that order. Each is opt-in.

### 5. Hand off the commit

When all the follow-up edits the user accepted are applied, hand off:

> "Ready when you are. Suggested commit: `feat(db): <slug>` — want me to stage + commit?"

**Never commit without being asked.** Match the recent log's style — `feat(db):` for new tables/columns, `fix(db):` for corrective migrations, `chore(db):` for index-only or trigger-only changes. **No `Co-Authored-By` / "Generated with Claude Code" / robot-emoji footers** — user-level rule overrides any project default.

## What this command does NOT replace

- `/audit/migrations` — broad sweep over **all** migrations checking idempotency + RLS + type drift across the whole tree. `/safe-migration` is per-migration.
- `/check` — pre-commit gate that runs once you're ready to commit. Use it after `/safe-migration` if you want the doc-hygiene + test-gap pass on the working diff.
- `/safe-edit` — coder ↔ reviewer loop for non-migration changes. The two are complementary; for a migration that also touches Express routes (e.g. new endpoint backed by the new table), run `/safe-migration` first, then `/safe-edit` on the route work.

## Tone

User-facing text:

- A one-line "Coordinating migration `<file>`…"
- The agent's verbatim report.
- The opt-in follow-up questions, one at a time.
- The commit handoff.

Don't narrate the agent fan-out or repeat the agent's findings in your own words.
