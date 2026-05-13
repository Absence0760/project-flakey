# @flakeytesting/cli

CLI for uploading test results and quality metrics to a Flakey backend.

## Commands

- `pnpm build` — `tsc` → `dist/`
- `pnpm dev` — `tsx src/index.ts` (run straight from source)

## Bin

The published binary is `flakey-upload` (see `bin` in `package.json`). The README and docs also invoke it as `flakey-cli` via `npx` — if renaming the bin, update both docs and the workflow `upload` script in the root `package.json`.

## Subcommands

Beyond the default upload, the CLI also uploads quality metrics:

- `coverage` — Istanbul `coverage-summary.json`
- `a11y` — axe-core results
- `visual` — visual regression manifest
- `ui-coverage` — per-route visit data

Expected file formats are documented in `docs/uploading-results.md`.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | — | API key for authentication |
| `FLAKEY_SUITE` | `default` | Suite-name fallback when `--suite` is omitted |
| `FLAKEY_RELEASE` | — | Release version label; backend upserts the release row + links the run |
| `FLAKEY_ENV` / `TEST_ENV` | — | Target environment label (e.g. `qa`, `stage`) stored on `runs.environment` |

CI-metadata chains (same ordering as the reporter packages):

- `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH`
- `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT`
- `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER`

`GITHUB_HEAD_REF` is preferred over `GITHUB_REF_NAME` because GitHub Actions sets `GITHUB_HEAD_REF` to the source branch on pull-request runs (the more useful value); `GITHUB_REF_NAME` on a PR is the merge ref.
