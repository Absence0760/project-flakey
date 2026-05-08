---
description: Bump version(s) for one or more @flakeytesting/* packages, refresh the lockfile, commit with the project's existing chore(packages): style, and prepare the GitHub release tag. Supports `<package>` = `all` to bump everything together.
argument-hint: <package> <version>  (e.g. core 0.9.0, or all 0.9.0)
---

Coordinate a release for `$ARGUMENTS`. The publish flow is documented in the root `CLAUDE.md`: bump the version in `package.json`, merge to `main`, then create a GitHub release with the matching tag (`<short-name>@<version>`, or `all@<version>`). This command does the bump-and-commit half end-to-end and prints the `gh release create` invocation for the user to run when they're ready.

## Argument shape

`$ARGUMENTS` is `<package> <version>`:

- `<package>` is one of the publish-workflow short names (matches the choices in `.github/workflows/publish.yml`): `core`, `cli`, `cypress-reporter`, `cypress-snapshots`, `playwright-reporter`, `playwright-snapshots`, `webdriverio-reporter`, `live-reporter`, `mcp-server`, or `all`.
- `<version>` is a plain semver string with no leading `v` (e.g. `0.9.0`, `1.0.0-rc.1`).

The directory mapping is `<short-name>` → `packages/flakey-<short-name>/`.

If `$ARGUMENTS` is missing or malformed (no version, unknown package name, version doesn't match `^\d+\.\d+\.\d+(-[\w.]+)?$`), abort with a one-line "expected: `<package> <version>` (package one of: core, cli, cypress-reporter, …, all)" and stop.

## Procedure

### 1. Confirm clean tree

Run `git status`. If there are uncommitted changes (staged or unstaged), abort: tell the user to commit or stash first. A release commit must include only the version bumps + lockfile update — nothing else.

### 2. Confirm branch

Confirm `git branch --show-current` reports `main`. If not, ask the user to confirm — releasing from a feature branch is unusual but not forbidden, and we don't want to force the user's hand.

### 3. Read current versions

For each affected package directory, read the current `version` from its `package.json`. Report the diff you're about to apply, e.g.:

```
About to bump:
  packages/flakey-core/package.json: 0.8.1 → 0.9.0
  packages/flakey-cli/package.json: 0.8.1 → 0.9.0
  ...

Tag will be: all@0.9.0
Commit message: chore(packages): bump all to 0.9.0 for all@0.9.0 release
```

For a single-package release, only that one directory + tag changes:

```
About to bump:
  packages/flakey-cypress-reporter/package.json: 0.8.1 → 0.9.0

Tag will be: cypress-reporter@0.9.0
Commit message: chore(packages): bump cypress-reporter to 0.9.0 for cypress-reporter@0.9.0 release
```

Wait for the user to confirm before any edit. **Do not bump versions unprompted.**

### 4. Sanity-check the version is a forward move

Compare the proposed version to the current version per affected `package.json`:

- If it's lower or equal, abort and ask the user to clarify (rare cases like `1.0.0-rc.2` → `1.0.0-rc.1` are almost certainly a typo).
- If it skips a major version (e.g. `0.8.1` → `2.0.0`), confirm with the user that this is intended — major-skipping has happened in other repos as a typo for `1.0.0`.

### 5. Apply the bumps

For each affected `package.json`, use `Edit` to change only the `"version"` field. Do not touch any other key. Do not reformat unrelated lines.

### 6. Refresh the lockfile

Run `pnpm install` from the repo root to update `pnpm-lock.yaml` so the workspace lockfile reflects the new versions. If any of the bumped packages is depended on by another in-tree package (e.g. `@flakeytesting/cli` depends on `@flakeytesting/core`), the lockfile move is required for installs to resolve cleanly.

If `pnpm install` fails, surface the error and stop — don't commit a half-broken release.

### 7. Stage + commit

Stage explicitly:

- For `all`: every `packages/*/package.json` plus `pnpm-lock.yaml`.
- For a single package: that package's `package.json` plus `pnpm-lock.yaml`.

Commit with the exact style the recent log uses:

- `all`: `chore(packages): bump all to <VERSION> for all@<VERSION> release`
- single: `chore(packages): bump <short-name> to <VERSION> for <short-name>@<VERSION> release`

**No `Co-Authored-By` / "Generated with Claude Code" / robot-emoji footers** — user-level rule. Use a plain single-line message; no body unless the user asks for one.

### 8. Print the release-creation step

Do not push or create the release yourself. Print the next steps for the user:

```
Bump committed on `main` (commit <SHA>).

Next steps (run when ready):
  git push origin main
  gh release create <TAG> \
    --title "<TAG>" \
    --notes "Release of <package> <version>"

Publishing happens automatically on release publish via .github/workflows/publish.yml.
```

If the user prefers a different release-notes flow (`--generate-notes`, a draft, a hand-written body), they can swap the last two lines themselves — surface the structure, not a fixed body.

## What this command does NOT do

- It does NOT push to `origin`. The user pushes when they're ready.
- It does NOT create the GitHub release. The publish workflow only fires on release publish, so the release-creation moment is a deliberate go/no-go gate the user holds.
- It does NOT run the publish workflow manually. `workflow_dispatch` is supported by `publish.yml` but should only be used to recover from a failed automatic run.
- It does NOT touch `CHANGELOG.md` or release notes — the project doesn't maintain a changelog, and the GitHub release body is the canonical notes surface.

## Tone

User-facing text:

- A one-line "Preparing release: `<package>` `<version>`…"
- The "About to bump" preview block.
- Wait for confirmation.
- After commit: the SHA + the next-steps block.

Don't narrate `pnpm install` output unless it errors.
