# @flakeytesting/cli

CLI for uploading test results, coverage, accessibility scans, visual diffs, and UI-coverage data to the [Flakey](https://github.com/Absence0760/project-flakey) dashboard. The reporters do the same upload at end-of-test; the CLI is for cases where you don't have a reporter (Selenium, custom runners) or you want to ship reports from CI separately from the test run.

## Install

```bash
pnpm add -D @flakeytesting/cli
# or
npm install --save-dev @flakeytesting/cli
```

The binary is `flakey-upload`. Also accessible as `flakey-cli` via `npx`.

## Quick start

```bash
# Upload a mochawesome / cypress JSON report
FLAKEY_API_URL=https://flakey.your-domain.com \
FLAKEY_API_KEY=fk_xxx... \
npx flakey-upload --suite my-app-e2e --reporter mochawesome --report-dir cypress/reports
```

## Subcommands

| Subcommand | Purpose |
|---|---|
| `upload` (default) | Upload a test run from a reporter's output directory |
| `coverage` | Upload Istanbul `coverage-summary.json` to a run |
| `a11y` | Upload axe-core accessibility scan results |
| `visual` | Upload a visual-regression manifest (per-test diff records) |
| `ui-coverage` | Upload per-route visit data so the dashboard knows which routes your tests exercise |

Run `flakey-upload <subcommand>` with no args for a usage line.

## Supported reporter formats

`--reporter <name>` accepts:

- `mochawesome` — Cypress / Mocha JSON (default)
- `junit` — JUnit XML (Jest, pytest, Go test, Java, .NET, PHPUnit)
- `playwright` — Playwright JSON reporter output
- `jest` — Jest JSON output
- `webdriverio` — WebdriverIO JSON output

For Cypress / Playwright / WebdriverIO projects, prefer the matching `@flakeytesting/<framework>-reporter` package — it uploads automatically with no extra CLI step.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | _(none — required)_ | API key for authentication |
| `FLAKEY_SUITE` | `default` | Suite-name fallback when `--suite` is omitted |
| `FLAKEY_RELEASE` | — | Release version (backend upserts release + links run) |
| `FLAKEY_ENV` / `TEST_ENV` | — | Target env label stored on `runs.environment` |

CI-metadata chains (same ordering across every Flakey package):

- `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH`
- `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT`
- `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER`

`GITHUB_HEAD_REF` is preferred over `GITHUB_REF_NAME` because GitHub Actions sets the former to the source branch on PR runs (the more useful value).

## Flags

```
flakey-upload [upload]
  --suite <name>            Suite name (or set FLAKEY_SUITE)
  --reporter <format>       mochawesome | junit | playwright | jest | webdriverio
  --report-dir <path>       Where to find the report file (default: cypress/reports)
  --screenshots-dir <path>  Where to find screenshot PNGs (default: cypress/screenshots)
  --videos-dir <path>       Where to find video MP4s (default: cypress/videos)
  --snapshots-dir <path>    Where to find snapshot bundles (default: cypress/snapshots)
  --branch <ref>            Override branch detection
  --commit <sha>            Override commit detection
  --ci-run-id <id>          Override CI run id
  --release <version>       Release label
  --environment <env>       Environment label
  --api-key <key>           Override FLAKEY_API_KEY
```

## Example: CI snippet (GitHub Actions)

```yaml
- name: Run tests
  run: npm test
- name: Upload to Flakey
  if: always()                          # upload even on test failure
  env:
    FLAKEY_API_URL: ${{ vars.FLAKEY_API_URL }}
    FLAKEY_API_KEY: ${{ secrets.FLAKEY_API_KEY }}
  run: npx flakey-upload --suite my-app --reporter jest --report-dir reports/
```

## Compatibility

- Node 20+

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
