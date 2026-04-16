# @flakeytesting/cli

CLI for uploading test results and quality metrics to a Flakey/Better Testing backend.

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

CI metadata (`BRANCH`, `COMMIT_SHA`, `CI_RUN_ID`) is read from standard env vars; see the GitHub Actions snippet in the root README.
