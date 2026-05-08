---
description: Pre-commit gate — runs code-reviewer + test-gap-checker + doc-hygiene-checker in parallel against the working diff. Advisory output. Cheaper than /safe-edit; use it before every non-trivial commit.
---

Run a parallel three-agent audit on the working diff, aggregate findings, and report. Advisory only — you don't apply fixes here, the user decides which to land.

## When to use this command

**Right fit:**

- Right before committing a non-trivial change.
- After a bug fix lands, to confirm a regression test went with it.
- After a feature change, to confirm coverage and docs went with it.

**Wrong fit — refuse:**

- Trivial diffs (typos, comment edits, dep-version bumps with no source change). The agents skip these, and running the command burns ~30s of agent time for nothing.
- Empty `git status` — there's nothing to audit. Tell the user.

## What this command does NOT do

- It does NOT apply any fixes. Each agent is read-only by design. The output is a list of gaps; the user picks what to fix.
- It does NOT replace `/safe-edit`'s coder ↔ reviewer loop. `/safe-edit` is for security-sensitive / migration / live-flow changes that warrant the 2-3x cost of a fix-and-re-review cycle. `/check` is the lighter pre-commit gate.
- It does NOT replace `/audit/*`. Those are periodic broad sweeps over the whole repo against one trust boundary; `/check` is per-change.

## Procedure

### 1. Sanity-check the diff exists

Run `git status`. If both staged and unstaged are empty, abort: tell the user there's nothing to audit.

### 2. Confirm it's not trivial

If the diff is trivial (typo, comment, single-line dep bump, generated-file regen only), abort with a one-line "trivial — skipping `/check`" message. The agents would each independently bail on the same diff.

### 3. Spawn three agents in parallel

Send a single message with three Agent tool calls:

- `code-reviewer` — prompt: "Review the working diff against project-flakey's documented conventions. Output the strict format from your spec."
- `test-gap-checker` — prompt: "Audit the working diff for missing unit / smoke test surface per project-flakey's test conventions. Output the format from your spec."
- `doc-hygiene-checker` — prompt: "Audit the working diff against project-flakey's docs hygiene rule. Output which docs need updating."

Parallel because they're independent — all three only `git diff` + `Read` files.

### 4. Aggregate

When all three return, build a single short report:

```
## /check report

**Change:** <one-sentence summary, take from whichever agent said it best>

### Code review (`code-reviewer`)
Status: <CLEAN | NEEDS_CHANGES>
<verbatim findings list, or "no concrete findings">

### Test gaps (`test-gap-checker`)
<verbatim verdicts list, or "test surface is consistent">

### Doc gaps (`doc-hygiene-checker`)
<verbatim verdicts list, or "doc set is clean">

### Recommendation
<one of:>
- All three came back clean — ready to commit.
- Code review and docs are clean; <N> test gap(s) — the user should decide whether to land tests now or in a follow-up.
- <N> code-review finding(s) — apply or push back before committing.
- Multiple gaps across review / tests / docs — list and let the user pick.
```

### 5. Hand off

Ask the user how they want to proceed. **Do not** apply any fixes automatically. Do not commit.

## Tone

Don't narrate the parallel-agent fan-out in user-facing text. The user sees:

- A one-line "Running review + test-gap + doc-hygiene checks…"
- The aggregated report.
- A short "Want me to apply the test gaps? Land it as-is? Add a follow-up task?" question at the end.
