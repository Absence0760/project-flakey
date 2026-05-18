---
description: Pre-tag readiness gate. Checks working tree, main, CI status, and the per-workspace deltas since the last release tag. Reports a green/red checklist. Read-only; never tags.
---

Run a pre-tag readiness audit before publishing a GitHub release. Report a green/red checklist; never tag, push, or publish anything. The user does the actual `gh release create` after they've reviewed the report.

## Why this exists

Releases here are **release-gated**: publishing a GitHub release fires three deploy workflows in parallel (`deploy-frontend.yml`, `deploy-backend.yml`, `deploy-studio.yml`), each with a skip-if-unchanged check that compares the new tag to the previous one. Cutting a tag with the working tree dirty, CI red, or unpushed commits means the deploy doesn't match what you think it does.

The gates are scattered (CI status, working tree, push state, last-tag delta per workspace) and the human-eyeball version is unreliable. This command runs them in one shot.

## When to use

**Right fit:** you're about to cut a release and want a single yes/no.

**Wrong fit — refuse:**
- The user is on a feature branch (not `main`) — explain that releases tag from `main`, ask whether to switch.

## Procedure

### 1. Confirm we're on main

```
git rev-parse --abbrev-ref HEAD
```

If not `main`, abort with: "releases tag from `main`; you're on `<branch>`. Switch with `git checkout main && git pull`, then re-run."

### 2. Run the universal gates

For each, mark **green** / **red** and capture a one-line reason for any red.

#### 2a. Working tree is clean

```
git status --porcelain
```

Empty → green. Anything → red ("uncommitted changes in: <files>"). Pay particular attention to plaintext SOPS siblings (`backend/.env`, `infra/terraform.tfvars`) — if they're showing up tracked, that's a separate Critical to flag.

#### 2b. main is up to date with origin

```
git fetch origin main
git rev-list --count HEAD..origin/main
git rev-list --count origin/main..HEAD
```

Both `0` → green. Behind → red. Ahead → red ("local main has unpushed commits — push first, wait for CI, then re-run"). Note: `git push` is on the `.claude/settings.json` deny list by default; surface this as a manual step.

#### 2c. Latest CI run on main is green

```
gh run list --branch main --limit 1 --json status,conclusion,workflowName,headSha,createdAt
```

`status=completed` and `conclusion=success` → green. Anything else → red ("CI on the head commit is `<status>/<conclusion>` — wait for green or investigate").

Also check the most recent runs of `ci.yml`, `codeql.yml`, and `audit.yml` — if any of those have an open failed run, surface as an amber row (informational; doesn't block but worth knowing).

If the user has `gh` but isn't logged in, recommend `gh auth login` and skip — don't fail the whole report.

### 3. Per-workspace deltas since last release

Find the last release tag:

```
git describe --tags --match 'v[0-9]*' --abbrev=0
```

For each workspace, list the commits + files changed since that tag. The release workflows skip-if-unchanged per workspace; this section makes the "what will actually deploy" picture explicit.

```
# Frontend
git log --oneline <last-tag>..HEAD -- frontend/
git diff --stat <last-tag>..HEAD -- frontend/

# Backend
git log --oneline <last-tag>..HEAD -- backend/
git diff --stat <last-tag>..HEAD -- backend/

# Studio
git log --oneline <last-tag>..HEAD -- studio/

# Infra (not a workspace, but matters for any deploy)
git log --oneline <last-tag>..HEAD -- infra/

# Workflows / .claude (informational — never deploys)
git log --oneline <last-tag>..HEAD -- .github/workflows/ .claude/
```

For each workspace, report:
- **Commits since:** count + one-line summaries
- **Will deploy:** `Yes` if any commit touched the workspace's tree (matches the skip-if-unchanged check in the workflow), `No` otherwise

If `Commits since` is `0` for every workspace, flag as red — there's nothing to release.

### 4. Sanity checks

#### 4a. Security postureSurface anything from the last `audit.yml` run that's still open:

```
gh issue list --label dependency-audit --state open
```

If issue exists, flag as amber and include the title — operator should know if a CVE issue is open before releasing.

```
gh api repos/{owner}/{repo}/code-scanning/alerts --jq '[.[] | select(.state=="open")] | length'
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length'
```

Non-zero either → amber. Don't block; just surface.

#### 4b. SOPS plaintext siblings absent

```
ls backend/.env infra/terraform.tfvars 2>/dev/null
```

Either present → amber ("plaintext SOPS sibling exists locally — confirm it's gitignored and not staged"). Both absent → green.

### 5. Build the report

```
# Release readiness — proposed `v<x.y.z>`

## Universal gates

| Gate | Status | Detail |
|---|---|---|
| On main | ✓ / ✗ | ... |
| Working tree clean | ✓ / ✗ | ... |
| main pushed + in sync with origin | ✓ / ✗ | ... |
| CI green on HEAD | ✓ / ✗ | ... |

## Per-workspace deltas since `v<last>`

| Workspace | Commits since | Will deploy | Notes |
|---|---|---|---|
| Frontend | <n> | Yes / No | <one-line> |
| Backend | <n> | Yes / No | <one-line> |
| Studio | <n> | Yes / No | <one-line> |
| Infra | <n> | n/a | <one-line> |

## Open audit signals

- audit.yml issue open: <yes/no, with title if yes>
- CodeQL alerts open: <count>
- Dependabot alerts open: <count>

## Changelog draft (commits since `v<last>`)

- abcd123 commit subject
- ...

## Verdict

<ALL GREEN — ready to publish a release with:
  gh release create v<x.y.z> --title "v<x.y.z> - <short summary>" --notes "<...>">

or

<NOT READY — fix the red items above first>
```

### 6. Hand off

End with:

> If everything's green, the next step is:
> ```
> git push origin main      # if you have commits ahead
> gh release create v<x.y.z> --title "..." --notes "..."
> ```
> I won't run those — `git push` and `gh release create` are both on the deny list by default. That's your call.

**Do not tag, do not push, do not create a release, do not auto-fix any of the red gates.** This command is read-only.

## Notes

- The whole thing should take under a minute. If a gate hangs (e.g. `gh run list` on a slow connection), skip it with a `⚠ skipped — <reason>` row rather than blocking the report.
- `gh` is required for the CI-status check and the open-alert sweep. If unavailable, fall back to a one-line note: "install `gh` to auto-check CI; manual: open the Actions tab and confirm green on the head commit."
- This command does NOT replace `docs/deployment.md`. It's a pre-flight, not the release procedure itself.
