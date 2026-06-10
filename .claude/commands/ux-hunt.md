---
description: Hunt for interaction/UX defects in the SvelteKit app — dead-ends, broken back/forward + URL-state, missing empty/loading/error states, stale selection, filter/sort inconsistency, keyboard traps. Fixes the objective bugs (with e2e), reports the judgment calls. Commits scoped; never pushes.
argument-hint: "[optional scope — a route or feature, e.g. /compare, the runs list, 'the errors master/detail'; omit to sweep the main app routes]"
---

Drive the app like a real user and hunt for **interaction defects** — flows that technically render but dead-end, lie, lose state, or strand the user. This is the behaviour-correctness cousin of `/polish-ui` (which redesigns layout to the visual quality bar) and `/persona` (which audits read-only from a role's POV). `/ux-hunt` **lands fixes** for the objective defects and writes up the subjective calls.

`$ARGUMENTS` is an optional scope (a route or feature). If empty, sweep the main `(app)` routes (dashboard, runs + run detail, errors, flaky, slowest, compare, releases, manual-tests, settings).

## What counts as a UX *bug* here (objective — fix these)

These are the classes that have actually shipped broken in this repo:

- **Dead-ends.** A control leaves the user somewhere with no way forward — e.g. a selection card whose dropdowns never populated because the entry path didn't fetch the data, or a modal with no working close.
- **Broken navigation state.** Back/forward, reload, and new-tab must preserve the view. URL-state must round-trip: every filter/sort/selection written to the URL is **restored on load** (and vice-versa), deep-links open the right thing, and a `replaceState` doesn't leave the visible state and the URL disagreeing.
- **State-coercion no-ops.** A "Clear" / "All" / reset that a downstream handler silently coerces back to a default (the control appears to do nothing). The default-vs-truthiness trap: `if (v && v !== def)` drops a legitimate empty selection.
- **Missing or wrong empty / loading / error states.** A list with no rows shows a blank pane instead of an empty state; a filtered-to-zero result shows the global empty instead of a "no matches" state; a failed fetch shows a stuck "Loading…"; a master/detail split leaves a **stale** or **blank-while-results-exist** detail pane when the selection is filtered out.
- **Filter / sort / count inconsistency.** A summary count that disagrees with the rendered rows; a "showing N of M" where M is the paginated count not the full set; an active-tab class that doesn't match the actual filter.
- **Keyboard / focus traps.** A modal that doesn't trap focus or close on Escape; a row-as-button with no keyboard activation; focus lost after an action.
- **Destructive-action surprises.** A delete with no confirm, or a click target that does two things at once (row navigates *and* the delete button inside it fires navigation).

## What is NOT in scope (hand off, don't fix here)

- Pure visual layout / spacing / archetype redesign → `/polish-ui`.
- Subjective wording / IA / "should this flow exist" → write it up; don't unilaterally redesign.
- Accessibility conformance depth (contrast ratios, ARIA semantics) → `/audit/accessibility` + `persona-accessibility-user`.

## Operating rules (non-negotiable — root `CLAUDE.md` guard rails)

- **Reproduce in the running app first.** Confirm the defect against the live stack (`pnpm dev:all` + seed) or a Playwright snippet before fixing — a UX bug you can't demonstrate is a hypothesis. The fix is proven by an **e2e test that fails on the old behaviour**.
- **Fix the root cause — never mask** (no arbitrary waits/retries to paper over a race; fix the readiness signal). (Rails 5–6.)
- **Reusable components & runes.** Build UI from `frontend/src/lib/components/*`; Svelte 5 runes only. Don't copy-paste markup. (Rails 9; `frontend/CLAUDE.md`.)
- **Be honest about non-findings.** A sound flow + a new e2e test that locks the good behaviour is a success. (Rail 3.)
- **Docs-as-code; commit scoped; never push.** (Rails 12; git workflow — fix and test as separate path-scoped commits.)

## Procedure

1. **Resolve scope** → concrete routes/components. Bring the stack up if it isn't (`pnpm dev:all`, seed once).
2. **Walk the flows like a user.** For each route in scope, exercise: first load (empty + populated), every filter/sort/search (incl. filtered-to-zero), selection + deep-link, back/forward/reload/new-tab, every button/affordance, and the keyboard path. Read the `+page.svelte` to confirm the mechanism behind anything that smells wrong (`syncUrl`/`readUrl` parity, `$derived` count sources, change-handler coercion).
3. **Probe each candidate** with a Playwright snippet that asserts the broken behaviour — that's your repro and your soon-to-be regression test.
4. **Fix the objective defects** at the root, in shared components where the markup repeats.
5. **Lock with e2e** in `tests-e2e/<route>/` (read-only assertions where possible so they're parallel-safe across worker tenants; wait on real signals, never sleeps). The test must fail on the old behaviour.
6. **Verify:** `pnpm check:frontend` + the new specs + the nearby existing specs for that route (report counts). For load-bearing flows (auth walls, tenant scoping, gate signals surfaced in UI) run `code-reviewer`.
7. **Commit** fix + tests scoped; **never push**. Write up the subjective/out-of-scope findings for the operator.

## Report

```
## /ux-hunt — <scope>

**Flows walked:** <routes/features exercised>

**Defects fixed:**
- <route> — <what stranded/confused the user> → <fix> | repro+test: <spec (e2e)>
- … (or "none objective; behaviour was sound")

**Reported (judgment calls / out of scope):** <subjective findings + where they belong (/polish-ui, /audit/accessibility) — or "none">

**Verification:** <check:frontend; new specs N/N; nearby specs N/N; review verdict if run>

**Commits:** <hash + subject>
```

## Tone

Lead with what was broken for the user and how it's fixed. Don't redesign on a whim — fix the defects, route the opinions to the operator.
