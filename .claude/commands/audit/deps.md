---
description: Cross-toolchain dependency audit — npm (backend), pnpm (frontend + packages workspace), GitHub Actions pinning
---

Sweep dependencies across every package manager in the project-flakey monorepo for known CVEs and version drift.

## What this is

The repo has three dependency trees plus CI:

- **npm** — `backend/` has its own `package-lock.json` and is intentionally outside the pnpm workspace
- **pnpm** — `frontend/` has its own `pnpm-lock.yaml` (not a workspace member); `packages/*` are pnpm workspace members orchestrated by the root `pnpm-workspace.yaml`
- **GitHub Actions** — `.github/workflows/*.yml` (action SHA pinning vs `@v1` floating tags)

## What to check

1. **Backend npm.** `cd backend && npm audit --json` (or `npm audit` for human output). Collect high/critical findings. For each: package, version, CVE, fix version. Backend uses Node 20+; flag if any dep no longer supports the runtime.

2. **Frontend pnpm.** `cd frontend && pnpm audit --json` (use `--ignore-workspace` if pnpm complains; the frontend isn't a workspace member). Collect critical/high.

3. **Workspace packages pnpm.** From the repo root, `pnpm audit --json` walks every `packages/*`. The reporter packages are published — a CVE in a published package's runtime dep is downstream-customer-facing, treat as one severity higher than the same CVE in a dev dep.

4. **Cross-package consistency.** Within `packages/*`, sibling packages should agree on versions of common deps where possible. A reporter package using `multer@2.x` and another using `multer@1.x` is drift, even if both work — list the deltas.

5. **Out-of-date checks.** `npm outdated` (backend) and `pnpm outdated` (frontend, packages root) for major-bump candidates. Major bumps of TypeScript / Vite / SvelteKit / Express are their own conversation — flag them but don't recommend the bump command.

6. **GitHub Actions ref pinning.** Walk `.github/workflows/*.yml`. For every `uses: <action>@<ref>`:
   - Floating refs (`@main`, `@v1`, `@v3`) are supply-chain risks for any workflow that touches `${{ secrets.* }}` or has `permissions: write-all`
   - SHA pins (`@<40-char-hex>`) are the safer default for security-sensitive workflows (anything that can deploy or read secrets)

   Flag floating refs in workflows that:
   - Touch `secrets.*` (any secret reference)
   - Have `id-token: write` (OIDC trust)
   - Run `npm publish` / `npm version` / similar

7. **`update-all` parity (workstation conventions).** The user's `~/CLAUDE.md` documents an `update-all` function that handles dnf / flatpak / rustup / cargo / pipx / npm globals / ollama. None of those are in the repo, but if the user runs them, the repo's local toolchains may drift relative to system tools. Flag if `npm` / `pnpm` / `node` system versions differ from what `package.json#engines` (if specified) requires. **Don't run `update-all` from this audit** — that's a system-wide action.

## Report

- **Critical** — known-exploited CVE in a path the app actually uses (not a transitive in dev-only); CVE in a published package's runtime dep.
- **High** — a CVE with a fix available in a non-major bump.
- **Medium** — version drift with no CVE but the upgrade is overdue (>6 months since latest); floating action ref on a secrets-touching workflow.
- **Low** — version skew between sibling workspace packages; outdated ref on a non-secrets workflow.

For each: package + version + advisory link + the file to change + the upgrade command.

## Useful starting points

- `backend/package.json`, `backend/package-lock.json`
- `frontend/package.json`, `frontend/pnpm-lock.yaml`
- `pnpm-workspace.yaml` (root) — covers `packages/*`
- `pnpm-lock.yaml` (root) — for the workspace
- `packages/*/package.json` — per-package deps and peerDeps
- `.github/workflows/*.yml` — every workflow

## Delegate to

`general-purpose` agent with this file as the prompt body. The audit is mostly running each tool in turn and collecting structured output — well within one agent's scope.

Read-only audit. Recommend upgrades; don't apply them without instruction (a major bump is its own conversation).
