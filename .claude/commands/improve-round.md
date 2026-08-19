---
description: Ship one meaningful improvement to an area of the app — in path-scoped per-piece commits with tests and docs — then run an independent code-reviewer audit and fix every finding until clean. The "do another round" loop.
argument-hint: [area or feature — optional; omit to let the command pick a high-value target]
---

Pick (or take) one area of the app, ship a genuinely useful improvement to it, then audit your own work with the `code-reviewer` agent and fix what it finds. Target: `$ARGUMENTS` (if empty, survey for a high-value target and propose it before building).

This is the repeatable "do another round of this" loop: **improve → commit per piece → audit → fix → re-audit → report.**

## When to use this command

**Right fit:**
- "Do another round" / "improve some area of the app" with latitude to choose.
- A specific area the user named that has a real gap, a missing interconnection between features, or a shipped-but-half-finished surface.
- Anywhere a small, self-contained, verifiable improvement plus a regression guard raises quality.

**Wrong fit — push back instead of running:**
- A large, uncertain feature that needs a product decision first (surface it with `AskUserQuestion` / a plan, don't free-run).
- A pure bug report with a known fix (just fix it; this loop is for *improvements* you scope yourself).
- Trivial edits (typos, dep bumps) — no round needed.

## Principles (the bar these rounds are held to)

- **Real gap, not churn.** Pick something with user value: a missing signal, a feature that should be interconnected but isn't, or a shipped surface that's inconsistent with the rest of the app. Confirm the gap is real by reading the code before building — don't assume.
- **Recommend the long-term solution and do it fully.** No band-aids; fix the root cause and extract the reusable piece when there is one.
- **Pin every fix with a test** so it can't regress — a unit test for pure logic, an e2e for a UI path, or a source-scan guard for a class of mistake. This covers **any bug surfaced while building**, not just the improvement itself: if the round uncovers a latent defect, fix it at the root and pin it (the adjacent edge cases too, so a near-miss can't resurface it) in its own commit. A fix with no test is not done.

## The loop

### 1. Choose the target (if `$ARGUMENTS` is empty or vague)

Survey for a high-value, bounded improvement. Read the relevant code to confirm the gap is real (a surface that's missing a signal, two features that should talk but don't, a pre-existing inconsistency). State the chosen target + why in one or two sentences, then build it. If the best target needs a product call, surface it first.

### 2. Decompose into pieces and build, committing as you go

Each discrete piece is its own commit, tests in the **same** commit as the code:

- **Pure logic** → extract to a small, testable module and unit-test it, rather than burying it inline where it can't be exercised.
- **User-facing strings** → add through the app's normal localization / content path; if a parity check enforces that every locale has the key, run it.
- **Schema / migration** → use `/safe-migration` instead; this loop is not for migrations.
- **Docs** → update in the same turn: the relevant `CLAUDE.md` / area docs, an architecture-decision note if there's a non-obvious trade-off, and a followups entry for anything you deliberately deferred.

**Commit discipline (shared working tree):**
- Always path-scoped: `git commit -m "…" -- path1 path2 …`. Never `git add -A`/`-u`, never a bare `git commit`.
- One piece = one commit. `git status` before each commit; confirm every path is yours.
- No AI attribution / `Co-Authored-By` / robot footer in messages.
- Commit only — never `git push` without an explicit ask.

### 3. Verify each piece before moving on

Run the cheapest sufficient check: the unit test for pure logic, the typecheck for a signature change (treat only **new** errors as yours — the repo may carry some pre-existing ones), the relevant e2e spec for a UI path, the locale-parity check for new strings. Don't declare a piece done on an unrun test.

### 4. Audit the round with `code-reviewer`

When the build is committed, spawn the `code-reviewer` agent against your commit **range** (not the working tree — it's already committed):

> "Review the diff of the last N commits (`git diff HEAD~N..HEAD`). <one-line description of what the round did>. Review for real correctness bugs and project-convention violations (documented ADRs, fail-closed defaults, layered resilience, accessibility/contrast, comment + abstraction discipline). Report concrete diff-level findings with file:line + recommended fix. Do not edit."

### 5. Fix every finding — but verify the finding first

For each Critical / Improvement:
- **Confirm it's real before acting.** If the finding makes a *numeric* claim (a contrast ratio, a threshold, an off-by-one), **compute it yourself** before applying — don't trade one bug for another by trusting an unchecked suggested value.
- If real, fix the **root cause**, and if the same mistake exists elsewhere (a copied pattern), fix those instances in the same turn — don't leave the broken pattern to be recopied.
- If the finding is wrong, say *why* you're not applying it; don't silently skip.
- **Watch for half-migrations.** If the round changed the meaning of a shared, cross-surface setting, don't reword/relabel one surface while another still computes the old way — either complete both or keep the labels matching the per-surface behaviour and document the ordering constraint in followups.
- Pin the fix with a test/guard, then commit it path-scoped (its own `fix(...)` commit).

### 6. Re-audit if the fixes were non-trivial; cap at 2 cycles

If step 5 changed real logic, re-run `code-reviewer` on the new commits. **Hard cap: 2 cycles.** Stop after the second even if minor nits remain — report them instead of looping.

### 7. Report

Short summary: what the round improved + why it mattered, the audit findings and how each was resolved (or why dismissed), what's verified (tests/guards), and any pre-existing-but-related issue you surfaced for a future round. End with a one-line offer to run another round or pick a different area.

## Tone

- Don't narrate agent fan-out or every command. The user reads the diffs.
- Be honest about scope: name what you deliberately deferred (and where it's tracked) versus what you finished.
- 1–2 sentence end-of-turn summary — let the commits speak.
