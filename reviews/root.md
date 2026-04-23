# Review: repo root (non-subdirectory files)

## Scope
- Files reviewed: 10 (package.json, pnpm-workspace.yaml, pnpm-lock.yaml high-level, docker-compose.yml, CLAUDE.md, README.md, .gitignore, .github/workflows/claude.yml, .github/workflows/deploy.yml, .github/workflows/publish.yml)
- Focus: bugs, misconfigurations, bad flows — GitHub Actions security/correctness, publish/deploy logic, docker-compose, package.json scripts, workspace config, CLAUDE.md accuracy, README branding/docs
- Reviewer confidence: high — all files read in full; cross-referenced package paths and workflow logic against actual repo structure

---

## Priority: high

### H1. Shell injection in `deploy.yml` and `publish.yml` via inline `${{ github.event.release.tag_name }}`

- **File(s)**: `.github/workflows/deploy.yml:26`, `.github/workflows/publish.yml:43-44`
- **Category**: security
- **Problem**: `${{ github.event.release.tag_name }}` is template-expanded by GitHub Actions before the shell ever sees the script. A release tag containing `$(cmd)` or backticks becomes active shell syntax inside the double-quoted assignment. Anyone who can publish a GitHub release (repo collaborators with write access, or a compromised account) can execute arbitrary commands on the runner with access to `NPM_TOKEN`, `AWS_ROLE_ARN`, and all other secrets in scope.
- **Evidence**:
  ```yaml
  # deploy.yml:26 — TAG assigned inline, not via env:
  run: |
    TAG="${{ github.event.release.tag_name }}"

  # publish.yml:43-44
  run: |
    TAG="${{ github.event.release.tag_name }}"
    MANUAL="${{ github.event.inputs.package }}"
  ```
- **Proposed change**: Move both values out of the `run:` body and into the step's `env:` map. GitHub treats env var values as data, not code, eliminating the injection path.
  ```diff
  -      - id: check
  -        run: |
  -          TAG="${{ github.event.release.tag_name }}"
  -          MANUAL="${{ github.event.inputs.package }}"
  +      - id: check
  +        env:
  +          TAG: ${{ github.event.release.tag_name }}
  +          MANUAL: ${{ github.event.inputs.package }}
  +        run: |
             if [[ "$TAG" == app@* ]] || ...
  ```
  Apply identically to the `check-tag` step in `deploy.yml` (same pattern, same fix).
- **Risk if applied**: None — logic is unchanged; only the expansion path is fixed.
- **Verification**: After the fix, create a test release with tag `test$(id)@1.0.0` and confirm the runner does not execute `id` (the step output should be `should_deploy=` with nothing set, not an executed command).

---

### H2. `publish.yml` `workflow_dispatch` silently ignores four packages

- **File(s)**: `.github/workflows/publish.yml:66-76`
- **Category**: bug
- **Problem**: The `detect-package` step includes `|| [[ "$MANUAL" == "<name>" ]]` for `core`, `cli`, `cypress-reporter`, `cypress-reporter`, and `playwright-reporter`. The four remaining packages — `playwright-snapshots`, `webdriverio-reporter`, `live-reporter`, `mcp-server` — are missing the `$MANUAL` clause. All four are valid options in the `workflow_dispatch` input. Selecting any of them manually produces a workflow run that completes with all publish jobs skipped, with no error.
- **Evidence**:
  ```bash
  # Lines 51–65 have the MANUAL guard:
  if [[ "$TAG" == core@* ]] || [[ "$MANUAL" == "core" ]] || [[ "$ALL" == "true" ]]; then

  # Lines 66–76 do NOT:
  if [[ "$TAG" == playwright-snapshots@* ]] || [[ "$ALL" == "true" ]]; then
  if [[ "$TAG" == webdriverio-reporter@* ]] || [[ "$ALL" == "true" ]]; then
  if [[ "$TAG" == live-reporter@* ]] || [[ "$ALL" == "true" ]]; then
  if [[ "$TAG" == mcp-server@* ]] || [[ "$ALL" == "true" ]]; then
  ```
- **Proposed change**:
  ```diff
  -          if [[ "$TAG" == playwright-snapshots@* ]] || [[ "$ALL" == "true" ]]; then
  +          if [[ "$TAG" == playwright-snapshots@* ]] || [[ "$MANUAL" == "playwright-snapshots" ]] || [[ "$ALL" == "true" ]]; then
  -          if [[ "$TAG" == webdriverio-reporter@* ]] || [[ "$ALL" == "true" ]]; then
  +          if [[ "$TAG" == webdriverio-reporter@* ]] || [[ "$MANUAL" == "webdriverio-reporter" ]] || [[ "$ALL" == "true" ]]; then
  -          if [[ "$TAG" == live-reporter@* ]] || [[ "$ALL" == "true" ]]; then
  +          if [[ "$TAG" == live-reporter@* ]] || [[ "$MANUAL" == "live-reporter" ]] || [[ "$ALL" == "true" ]]; then
  -          if [[ "$TAG" == mcp-server@* ]] || [[ "$ALL" == "true" ]]; then
  +          if [[ "$TAG" == mcp-server@* ]] || [[ "$MANUAL" == "mcp-server" ]] || [[ "$ALL" == "true" ]]; then
  ```
- **Risk if applied**: None.
- **Verification**: Trigger `workflow_dispatch` with `package: live-reporter` and confirm the `publish-live-reporter` job evaluates its `if:` as true and runs.

---

### H3. Second `aws s3 sync` in `deploy.yml` overwrites all files with `max-age=0`

- **File(s)**: `.github/workflows/deploy.yml:110-113`
- **Category**: bug
- **Problem**: The deploy intent is two-pass: first pass marks JS/CSS bundles `immutable`; second pass marks HTML/JSON `must-revalidate`. The second `aws s3 sync` uses `--include "*.html" --include "*.json"` but has no `--exclude "*"` before them. AWS CLI filter semantics: without an explicit exclusion, the default rule is include-all, making the `--include` flags a no-op. The second pass re-uploads every file in `frontend/build/` with `Cache-Control: max-age=0, must-revalidate`, overwriting the `immutable` headers set by the first pass on every JS/CSS bundle. After each deploy, CDN edge nodes and browsers revalidate every asset on every request.
- **Evidence**:
  ```yaml
  # Second sync — no --exclude "*" before --include
  aws s3 sync frontend/build s3://${{ secrets.FRONTEND_BUCKET }} \
    --cache-control "public, max-age=0, must-revalidate" \
    --include "*.html" \
    --include "*.json"
  ```
- **Proposed change**:
  ```diff
           aws s3 sync frontend/build s3://${{ secrets.FRONTEND_BUCKET }} \
             --cache-control "public, max-age=0, must-revalidate" \
  +          --exclude "*" \
             --include "*.html" \
             --include "*.json"
  ```
- **Risk if applied**: None functionally. The first-pass immutable headers on JS/CSS will now survive. Confirm no other file types (e.g. `.webmanifest`) need the `must-revalidate` treatment and add `--include` clauses as appropriate.
- **Verification**: After deploying, `curl -I https://<cloudfront>/assets/<hash>.js` must return `cache-control: public, max-age=31536000, immutable`. Before the fix it returns `max-age=0`.

---

### H4. `package.json` `upload` script references non-existent path `packages/cli`

- **File(s)**: `package.json:11`
- **Category**: bug
- **Problem**: The `"upload"` script is `"cd packages/cli && node dist/index.js"`. The directory `packages/cli` does not exist — the CLI package is at `packages/flakey-cli`. Running `pnpm upload` exits immediately with `ENOENT`.
- **Evidence**:
  ```json
  "upload": "cd packages/cli && node dist/index.js"
  ```
  `ls packages/` output: `flakey-cli  flakey-core  flakey-cypress-reporter  ...` — no `cli`.
- **Proposed change**:
  ```diff
  -    "upload": "cd packages/cli && node dist/index.js"
  +    "upload": "cd packages/flakey-cli && node dist/index.js"
  ```
- **Risk if applied**: None.
- **Verification**: `pnpm upload` no longer exits with ENOENT.

---

## Priority: medium

### M1. No concurrency group on `deploy.yml` — parallel ECS deploys race

- **File(s)**: `.github/workflows/deploy.yml` (top level)
- **Category**: bug
- **Problem**: Two rapid releases trigger two simultaneous workflow runs. Both call `aws ecs update-service --force-new-deployment` on the same cluster/service. The `aws ecs wait services-stable` in the first run can time out or succeed against a task set immediately replaced by the second run. Separately, `deploy-backend` and `deploy-frontend` run in parallel (both `needs: [check-tag]` only), so a failed backend deploy does not block the frontend deploy — a new frontend build can go live against a stale/broken API.
- **Proposed change**:
  ```diff
  +concurrency:
  +  group: deploy-production
  +  cancel-in-progress: true
  +
   jobs:
     check-tag:
  ```
  Additionally, make `deploy-frontend` depend on `deploy-backend` to prevent split-brain deploys:
  ```diff
   deploy-frontend:
  -  needs: [check-tag]
  +  needs: [check-tag, deploy-backend]
  ```
- **Risk if applied**: With `cancel-in-progress: true`, a rapid re-release cancels the prior in-flight deploy. Verify ECS is not left with a degraded service if the cancel hits during `wait services-stable`.
- **Verification**: Publish two releases in rapid succession; confirm only one deploy job runs to completion.

---

### M2. `publish.yml` `always()` runs dependent publish jobs even when `publish-core` failed

- **File(s)**: `.github/workflows/publish.yml:117`, `155`, `195`
- **Category**: bug
- **Problem**: `publish-cypress-reporter`, `publish-playwright-reporter`, and `publish-webdriverio-reporter` each declare `needs: [detect-package, publish-core]` with `if: always() && ...`. The `always()` was added so the job runs when `publish-core` is skipped (different package tag). It also runs when `publish-core` failed. If `publish-core` fails after a partial upload (e.g. `@flakeytesting/core` is not successfully published or is published with a broken build), these reporters will still publish against the stale/broken core version.
- **Evidence**:
  ```yaml
  publish-cypress-reporter:
    needs: [detect-package, publish-core]
    if: always() && needs.detect-package.outputs.cypress_reporter == 'true'
  ```
- **Proposed change**: Replace `always()` with an explicit check on `publish-core` result:
  ```diff
  -    if: always() && needs.detect-package.outputs.cypress_reporter == 'true'
  +    if: >
  +      needs.detect-package.outputs.cypress_reporter == 'true' &&
  +      (needs.publish-core.result == 'success' || needs.publish-core.result == 'skipped')
  ```
  Apply identically to `publish-playwright-reporter` (line 155) and `publish-webdriverio-reporter` (line 195).
- **Risk if applied**: None — this is strictly more correct. A failed core publish now gates dependent publishes.
- **Verification**: Introduce a deliberate build failure in `publish-core` and confirm `publish-cypress-reporter` is skipped rather than running.

---

### M3. README describes wrong triggers for `deploy.yml` and `publish.yml`

- **File(s)**: `README.md:364-365`
- **Category**: inconsistency
- **Problem**: Two statements in the README CI/CD section are factually wrong:
  - "`deploy.yml` — builds and deploys ... on push to `main`" — the actual trigger is `release: published` (and `workflow_dispatch`).
  - "`publish.yml` — publishes all packages ... when their source changes" — there is no source-change detection; the trigger is release tags matching `<package>@<version>` (and `workflow_dispatch`).
- **Evidence**:
  ```markdown
  - `deploy.yml` — builds and deploys backend (Docker → ECS) and frontend (static → S3/CloudFront) on push to `main`
  - `publish.yml` — publishes all packages in `packages/` to npm when their source changes (...)
  ```
- **Proposed change**:
  ```diff
  -  - `deploy.yml` — builds and deploys backend (Docker → ECS) and frontend (static → S3/CloudFront) on push to `main`
  -  - `publish.yml` — publishes all packages in `packages/` to npm when their source changes (...)
  +  - `deploy.yml` — builds and deploys backend (Docker → ECS) and frontend (static → S3/CloudFront) on GitHub release publish (tag `app@*`) or manual dispatch
  +  - `publish.yml` — publishes packages to npm on a matching release tag (e.g. `core@1.2.3`, `all@1.0.0`) or manual dispatch; see workflow for full tag format
  ```
- **Risk if applied**: None.
- **Verification**: Read-only docs change.

---

### M4. `CLAUDE.md` incorrectly describes `publish.yml` trigger

- **File(s)**: `CLAUDE.md:35`
- **Category**: inconsistency
- **Problem**: CLAUDE.md says "`publish.yml` publishes packages to npm on `main` when their source changes." This is the instruction set agents rely on when deciding how and when to version packages. The actual trigger is release tags, not source changes on `main`. An agent following this instruction will expect pushing source changes to `main` to trigger a publish — it does not. The "Bump versions with an explicit commit" guidance that follows is also incomplete: a version bump commit alone is insufficient; a release tag must be created.
- **Evidence**:
  ```markdown
  `publish.yml` publishes packages to npm on `main` when their source changes. Bump versions with an explicit commit.
  ```
- **Proposed change**:
  ```diff
  -`publish.yml` publishes packages to npm on `main` when their source changes. Bump versions with an explicit commit.
  +`publish.yml` publishes packages to npm when a GitHub release is published with a matching tag (`<package>@<version>`, e.g. `core@1.2.3`; use `all@<version>` for all packages). To publish: bump the version in the package's `package.json`, merge to `main`, then create a GitHub release with the matching tag.
  ```
- **Risk if applied**: None.
- **Verification**: Read-only docs change.

---

### M5. README Quick Start missing `pnpm install` at repo root

- **File(s)**: `README.md:22-27`
- **Category**: bug
- **Problem**: Quick Start Step 2 installs `backend/` (npm), `frontend/` (pnpm), and `packages/flakey-cli` (pnpm) individually, but never runs `pnpm install` at repo root. The root `package.json` lists `concurrently` as a devDependency. Step 4 (`pnpm dev`) calls `concurrently` via the root script. Without the root install, Step 4 fails with "concurrently: command not found".
- **Evidence**:
  ```bash
  # README Step 2 — no root pnpm install:
  cd backend && npm install
  cd ../frontend && pnpm install
  cd ../packages/flakey-cli && pnpm install
  ```
  ```json
  // package.json:13-15
  "devDependencies": { "concurrently": "^9.0.0" }
  ```
- **Proposed change**: Insert root install at the top of Step 2 and remove the redundant flakey-cli step (workspace root install covers all `packages/*`):
  ```diff
   ### 2. Install dependencies
  +
  +```bash
  +pnpm install
  +```
  +
   ```bash
   cd backend && npm install
   cd ../frontend && pnpm install
  -cd ../packages/flakey-cli && pnpm install
   ```
- **Risk if applied**: None.
- **Verification**: Follow the Quick Start from a clean checkout; `pnpm dev` launches both services without error.

---

## Priority: low

### L1. README user-facing prose uses old "Flakey" brand name

- **File(s)**: `README.md:93`
- **Category**: inconsistency
- **Problem**: CLAUDE.md rule: "When touching user-facing copy, prefer 'Better Testing'." Line 93 uses "Flakey" twice in explanatory prose (not inside a code block, package name, or env var).
- **Evidence**:
  ```
  (e.g. to run `mochawesome` alongside Flakey), `config.reporterOptions` is reshaped by the wrapper,
  so pass Flakey's options explicitly as the third arg:
  ```
- **Proposed change**:
  ```diff
  -(e.g. to run `mochawesome` alongside Flakey), `config.reporterOptions` is reshaped by the wrapper, so pass Flakey's options explicitly as the third arg:
  +(e.g. to run `mochawesome` alongside Better Testing), `config.reporterOptions` is reshaped by the wrapper, so pass the Better Testing reporter options explicitly as the third arg:
  ```
- **Risk if applied**: None.
- **Verification**: No runtime impact.

---

### L2. `claude.yml` does not explicitly pin `base_branch: main`

- **File(s)**: `.github/workflows/claude.yml:35-39`
- **Category**: inconsistency
- **Problem**: CLAUDE.md states the Claude Code Action "bases new branches off `main` and opens draft PRs against `main`." The workflow does not pass a `base_branch` parameter to `anthropics/claude-code-action@v1`. The action's default depends on the repo's configured default branch. If the default branch is ever renamed, or the action's default behavior changes between versions, the CLAUDE.md guarantee silently breaks without any workflow error.
- **Evidence**:
  ```yaml
  - name: Run Claude Code
    uses: anthropics/claude-code-action@v1
    with:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      claude_args: "..."
      # no base_branch
  ```
- **Proposed change**: If `claude-code-action@v1` exposes a `base_branch` input, add it:
  ```diff
       with:
         claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
         github_token: ${{ secrets.GITHUB_TOKEN }}
  +      base_branch: main
         claude_args: "..."
  ```
  If the action does not support that input, update CLAUDE.md to replace "bases new branches off `main`" with "bases new branches off the repo default branch (currently `main`)".
- **Risk if applied**: None.
- **Verification**: Trigger the action via an issue comment; confirm the opened PR targets `main`.

---

### L3. No `.nvmrc` at repo root; Node 20 hardcoded in workflows without a local anchor

- **File(s)**: `.github/workflows/deploy.yml:81`, `.github/workflows/publish.yml` (all `setup-node` steps)
- **Category**: inconsistency
- **Problem**: All workflow jobs pin `node-version: 20`. There is no `.nvmrc` at repo root and no `engines` field in root `package.json` or `frontend/package.json`. Local developers using `nvm` have no version anchor. When Node 20 reaches EOL and workflows are bumped to 22, local dev environments will silently diverge.
- **Proposed change**: Add `.nvmrc` at repo root:
  ```
  20
  ```
  Optionally add to `frontend/package.json`:
  ```diff
  +  "engines": { "node": ">=20" },
  ```
- **Risk if applied**: None.
- **Verification**: `nvm use` at repo root selects Node 20 without requiring a version argument.
