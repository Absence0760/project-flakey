---
description: Polish the UI/UX of a single page or component to project-flakey's quality bar — natural-width tables, status-tinted accents, at-risk strips, master/detail splits, friendly dates. Delegates to the `ui-polisher` agent.
argument-hint: <page-route or component path>
---

Polish the UI/UX of `$ARGUMENTS` using project-flakey's `ui-polisher` agent.

## When to use this command

**Right fit:**

- An index page that doesn't use the wide-screen real estate well (cramped middle, cards in a 280px grid on a 1920px display).
- A page where alignment drifts row-to-row (badges / chips / dates at different x-positions).
- A page leaking raw ISO dates, redundant h1s, inline create forms, missing filter tabs or URL state.
- A page whose archetype doesn't match the data — flat card list when the data is workflow-state, no master/detail when each item has a rich inspector, no heatmap when the data is items × time-series.
- A modal or component used in multiple places where consistency matters.

**Wrong fit — tell the user and stop:**

- A purely-functional Settings / login / form page with no real-estate or scanability problem.
- A detail page (`/runs/[id]`, `/releases/[id]`) that already has rich UI — polish on detail pages usually has a worse cost/value ratio than on index pages.
- A request that's really a feature, not a polish — "add a graph of test runs over time" needs a feature plan, not the polish agent.
- An asks-for-everything sweep ("polish all pages"). Pick one and tell the user to invoke this command again for the next.

## Resolving the target

`$ARGUMENTS` can be:

- A **route slug** (`/runs`, `/flaky`, `/errors`, `/releases`) — resolves to `frontend/src/routes/(app)<slug>/+page.svelte`.
- A **file path** (`frontend/src/lib/components/ErrorModal.svelte`) — used as-is.
- A **component name** (`ErrorModal`, `Lightbox`) — resolve via `find frontend/src/lib/components -name "<name>.svelte"`.

If the argument is empty or "audit", list the candidate index pages with a one-line "why this one matters most right now" and ask the user to pick. Don't blanket-sweep.

## The flow

1. **Pre-flight:**
   - Confirm the frontend dev server is up at `:7778` (try `curl -s -o /dev/null -w '%{http_code}' http://localhost:7778/`). If not, tell the user and stop — the agent's screenshot step needs it.
   - Confirm the admin auth storageState exists at `frontend/tests-e2e/.auth/admin.json`. If not, tell the user to run the playwright auth setup once.

2. **Resolve target → invoke the agent:**

   Spawn the `ui-polisher` agent with a prompt like:

   > "Polish the UI/UX of `<resolved file path>`. The user's stated intent was: `<the original argument string>`. Follow your agent spec: audit, plan, edit, verify, report. Do not commit."

   The agent's spec covers the design language, screenshot capture, type-check, and e2e selector updates. Trust it.

3. **Relay the agent's report.** When it returns, surface:

   - The before/after screenshot paths so the user can open them.
   - The list of files changed (run `git diff --stat` to confirm).
   - Any e2e selector updates the agent applied so the user can sanity-check those edits.
   - The agent's "Notes for the human" section verbatim.

4. **Wait for the user's call on the commit.** Do not pre-stage or pre-commit. When the user says yes:

   - Stage the changed files explicitly (don't `git add -A` — risk of pulling in unrelated test results / screenshots).
   - Commit message follows the project's `ui(<scope>):` convention. **No `Co-Authored-By` / "Generated with Claude Code" / robot-emoji footers** — the user-level rule wins.
   - Example: `git commit -m "ui(<scope>): <one-liner>" -m "<3-5 line body explaining what archetype + which patterns applied>"`.

## Cost reality

This command costs more than a normal edit (a screenshot pass, full type-check, possible e2e re-run, an agent context). Don't burn it on a 5-pixel padding tweak — for that, the user edits directly. The command earns its cost on archetype-level or hierarchy-level changes (a card grid that should be a table, a flat list that should be master/detail, etc.).

## What this command does NOT replace

- `/check` for a pre-commit gate (code-review + test-gap + doc-hygiene).
- `/safe-edit` for security-sensitive changes.
- `/audit/*` for periodic broad sweeps.

## Tone

Don't narrate the agent's internal steps. The user sees:

- A one-sentence "Resolving target → `<path>`. Spawning the polisher."
- The agent's structured report (audit findings + changes + verification + notes), relayed.
- A "Want me to commit?" question with the suggested commit message.
