---
description: Fix a failing CI job from a GitHub Actions run. Root-causes the failure, fixes it without coding around it (no retry/timeout/skip band-aids), reproduces locally with the same command CI used, and lands coverage so the failure can't return silently.
argument-hint: "<GitHub Actions run URL or run ID> [optional: which job/shard, if known]"
---

Fix the failing CI run `$ARGUMENTS`. Find the real cause, fix it at the root, add coverage, and stop before pushing.

## The two hard rules (these override convenience)

1. **Do not code around the issue.** A red test that catches a real defect is doing its job — fix the defect, not the test. Forbidden "fixes" unless you can prove the failure is pure infrastructure noise *and* name the structural reason the band-aid is the right call:
   - bumping a timeout / retry count / `sleep` / wait to paper over a slow or racy path
   - adding `.skip` / `xfail` / `continue-on-error` / `fail-fast: false` to hide a failure
   - loosening an assertion, widening a tolerance, or deleting the failing case
   - re-running until green
   If you catch yourself reaching for one of these, stop: you've found the symptom, not the cause. A red test guarding a project invariant is **especially** doing its job — fix the defect.

2. **Be honest about what actually failed, and add coverage where the gap let it through.** Report the real failure, not a convenient one. Whatever broke, leave behind something that fails loudly and early next time — a pinning test for a code defect, an explicit assertion / health-gate for an infra step, a guard for a missing precondition. Coverage ships in the **same commit** as the fix.

## Procedure

### 1. Pull the failure apart

- `gh run view <id>` to see which job(s) failed and at which step. For a sharded or matrixed suite, note the exact shard/leg. A path-filter or `changes` gate job can make a job *skip* rather than fail — confirm which job actually went red.
- `gh run view <id> --log-failed` (or `gh run view --job=<job-id> --log-failed`) and grep to the **actual error** — the first thing that broke, not the final `exit 1`. Scroll past the harness boilerplate; the real signal is usually an exception, a non-zero command, a lint/format diff, a 4xx/5xx, or a "deadline exceeded" deep in the step output. `gh` rate-limits — anchor your greps rather than dumping whole logs repeatedly.
- Quote the failing job + step name + the error line back to the user so you're both anchored on the same failure.

### 2. Classify it honestly

Decide which of these it is, and say so:

- **Genuine defect** — the app / test / migration is wrong. Fix the defect; pin it with a test.
- **Test bug** — the test asserts the wrong thing, has a race in *its own* setup, or collides with seed/fixture data. Fix the test correctly (not by loosening it).
- **Infra flake** — a CI-environment failure (cold service container, slow image pull, port clash, resource limit). The fix is to **remove the fragile dependency or make the step deterministic**, not to retry it. If retries already exist and still failed, that is proof retries are the wrong tool — find what the step is actually waiting on and gate on *that*, or restructure so the fragile operation never happens.

"It passed on re-run / on the other shards" narrows it toward flake, but does **not** license a band-aid — a flake still has a root cause.

### 3. Read the surrounding context before changing it

CI steps and workflow files often carry comments documenting prior incidents (sometimes cited by run ID) and why the current shape exists. Read them. Your fix should make those comments obsolete by removing the failure mode, and you should update or replace the comments to match — don't leave a comment describing a workaround you just deleted. If the root cause might be a schema / migration interaction, pull in the `migration-coordinator` agent before touching DDL.

### 4. Reproduce locally, then verify the fix locally

Wherever the failure can be reproduced on this workstation, do it — it's the difference between a guess and a fix. **Re-run the exact command CI used** (e.g. the same `pnpm test` / test invocation the failing step ran), against CI's actual conditions — the pinned tool versions and default behaviour, not what a comment or doc claims. If your repro only passes because you configured it to match a stale assumption, you've validated the assumption, not the fix.

- Reproduce with the **same runner** the job used: the same lint/format/typecheck/test/build command, pointed at the same target (spec, module, package, or workspace) — not a looser or broader substitute.
- If the job depends on a service (database, cache, object store, browser), bring up the local equivalent the same way the workflow does before running the failing step.
- If you must cycle or wipe local state to get a faithful repro, first confirm it holds only standard seed/fixture data — if there's custom state, **ask before wiping**.

Confirm the failure reproduces *before* the fix and is gone *after*. Capture the evidence (counts, status codes, exit codes) — report it, don't just claim it.

### 5. Apply the fix at the lowest sensible layer

- If the same broken pattern appears in **sibling jobs / steps**, fix all of them — don't leave the flake live elsewhere after fixing it in one place.
- Keep the blast radius proportional: prefer the surgical, version-/behaviour-stable change over a broad upgrade that could destabilise unrelated jobs, unless the broad change is genuinely the root fix.
- Match the file's existing voice; if it documents incidents by run ID, document yours the same way.
- Spin up the `Explore` agent if you need to find every sibling site of the pattern before you fix.

### 6. Sweep docs

If a doc describes the behaviour you changed (a CI job's steps, a command, an env var, a port), update it in the same turn — deferred docs are drift.

### 7. Commit, don't push

- One coherent piece → one **path-scoped** commit, fix + coverage + doc update together: `git commit -m "…" -- <paths>`. Never `git add -A`/`-u`, never a bare `git commit` — path-scope so a concurrent session's unrelated changes aren't swept in.
- No `Co-Authored-By` / "Generated with" / AI-attribution trailer in the message — write it as a human would.
- Validate before committing where cheap: `python3 -c "import yaml; yaml.safe_load(open('<workflow>'))"` for workflow YAML, the relevant linter/test for code.
- **Never `git push`.** Publishing is the operator's call — STOP before pushing.
- Consider a `code-reviewer` pass on the diff before you hand back, especially if the fix touched auth, a money path, tenant isolation, or a webhook.

## Output

End with: the failing job + step + root cause (one or two sentences), the fix and *why it's not a band-aid*, the coverage you added, the local verification evidence (the exact command + its result), and any residual risk worth flagging (e.g. "this is correct only because CI pins the tool at version X.Y — a version bump would change the assumption"). Keep it tight; the user can read the diff.
