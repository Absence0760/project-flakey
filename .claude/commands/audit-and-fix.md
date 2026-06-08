---
description: Pick one app area (random if none given), audit it for real bugs, fix at the root, and back the fix with as much unit/smoke/e2e coverage as the change warrants. Commits scoped; never pushes.
argument-hint: "[optional area — a path, glob, module, or feature, e.g. backend/src/retention.ts or 'the live-run merge path']"
---

Deep-audit a single area of project-flakey, fix the real issues you find, and ship tests with the fix. Unlike `/audit/*` (read-only sweeps that write a review doc) and `/check` (advisory pre-commit gate), this command **lands changes**: fix + tests + scoped commits.

`$ARGUMENTS` is the area to audit. If empty, you pick one (see step 1).

## Operating rules (non-negotiable)

- **Fix the root cause — never mask.** No inflated timeouts, sleeps, retries, loosened assertions, or swallowed errors to make something pass. If you can't fix it now, surface it explicitly. (Root `CLAUDE.md` guard rails 5–6.)
- **Be honest when there's no bug.** If the area is sound, say so plainly and make the deliverable the *test coverage gap* you closed — do **not** invent a "fix" to justify the command. A no-bug-found result with new tests is a success.
- **Respect tenancy & secrets.** Don't bypass RLS, don't log PII/secrets, don't process GovRAMP-scoped data. If the area is auth/tenancy/migrations/money/PII, treat it as load-bearing (mandatory review pass in step 5).
- **Docs-as-code.** If you change a behaviour, command, env var, port, or convention, update its docs in the same commit (guard rail 12).
- **Commit each logical unit, path-scoped; never push.** Fix and tests are separate commits. Use `git commit -m "…" -- <paths>` (the scope-guard hook blocks bare/whole-tree commits).

## Procedure

### 1. Resolve the area

- **If `$ARGUMENTS` is given:** that's the scope. Resolve it to concrete files (a path, glob, module name, or a feature described in prose — map prose to files first).
- **If `$ARGUMENTS` is empty:** pick one yourself. Favour **self-contained, testable, bug-prone, under-covered** code over breadth. A good heuristic:
  - Map source modules to their dedicated test files (e.g. for the backend: `ls backend/src/*.ts` vs `backend/src/tests/`; for the frontend, routes/components vs `tests-e2e/` + `*.test.ts`).
  - Rank candidates by: **few/no dedicated tests** × **hot path or recent bug activity** (`git log --oneline -20` on the file) × **logic density** (not pure config/types).
  - Skip: generated files, pure type files, seed scripts, anything needing live cloud creds, and areas already covered by a recent commit in this session.
  - State your pick and *why* in one line before diving in. Treat "random" as "an area I haven't been steered to" — variety across invocations is the point, so don't keep landing on the same module.

### 2. Audit for real issues

- Use a recon pass to **map the area before judging it**: the data model / call sites / invariants it must hold. For anything non-trivial, spawn an `Explore` agent (or the `auditor` agent for a strict written review) to map callers, schema, and the invariants — don't guess at a hot path's contract.
- Hunt for **correctness** bugs first (wrong results, broken invariants, race conditions, inconsistent logic across paths, edge cases: null/empty/overflow/unicode/concurrent), then security/tenancy, then robustness. Stylistic nits are out of scope unless they hide a bug.
- For each candidate finding, **confirm it's real** by tracing the code — read the schema/migration/caller, don't assert from a single file. Discard plausible-but-wrong findings.

### 3. Fix the real issues at the root

- Apply the durable fix. Match surrounding code style, comment density, and idiom.
- If a quick patch and the durable fix diverge, name the durable fix even if you ship the patch (guard rail 6).
- Keep the fix tightly scoped to the issue — resist refactoring the whole area.

### 4. Add as much coverage as the change warrants

Pick the right layer per the repo's conventions (see `backend/docs/testing.md`, `frontend/CLAUDE.md`, `frontend/tests-e2e/README.md`):

- **Backend pure functions** → `*.unit.test.ts` (`node --test`, no DB).
- **Backend DB/HTTP behaviour** → `*.smoke.test.ts` (spawns the server on a free port — grep existing `const PORT =` to avoid collisions — registers a fresh org, hits real endpoints). Needs `pnpm db:up`.
- **`@flakeytesting/*` package logic** → `node --test` in the package.
- **Frontend user-visible behaviour** → Playwright `tests-e2e/` (no Svelte component unit tests — vitest here is pure-helpers only). Needs the full stack + seed.
- Write tests that **lock in the fixed behaviour and the invariant it restores** (a regression would fail them), plus the obvious edge cases. If the area was sound, still backfill the missing coverage — that's the deliverable.
- If something is genuinely untestable, say *why* rather than skipping silently (guard rail 3).

### 5. Verify + review

- Run the type gate (`pnpm check:backend` / `pnpm check:frontend` as relevant) and the **new** tests.
- Run the **nearby existing** tests that exercise the same path to prove no regression — report the pass/fail counts faithfully.
- If the change is load-bearing (auth, tenancy/RLS, migrations, gate signals, ingest/stat math, money/PII), run the `code-reviewer` agent on the diff and apply or push back on its findings before committing.

### 6. Commit (scoped) — never push

- Commit the **fix** and the **tests** as separate path-scoped commits (conventional-commit style, no AI/co-author trailer). If a behaviour/doc changed, the doc edit rides with the commit that caused it.
- If you only added tests (no bug), one `test(...)` commit is fine.
- Do **not** `git push`.

## Report

End with a tight summary:

```
## /audit-and-fix — <area>

**Picked:** <area> — <one-line why> (omit the "why" if the user named it)

**Issue(s) found:** <each real bug: what was wrong + the root-cause fix>  — or "none; area is sound"

**Tests added:** <files + what they lock in (layer: unit/smoke/e2e, count)>

**Verification:** <type gate result; new tests N/N; nearby existing suites N/N; review verdict if run>

**Commits:** <hash + subject, one per line>

**Deferred / recommended:** <anything you intentionally didn't do, with the long-term fix named — or "nothing outstanding">
```

## Tone

Don't narrate the agent fan-out. Lead with the pick and the verdict. If you found and fixed a real bug, state it plainly; if you didn't, say the area was sound and the coverage was the gap — don't dress up a non-finding.
