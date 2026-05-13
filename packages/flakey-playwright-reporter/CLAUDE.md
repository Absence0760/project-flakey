# @flakeytesting/playwright-reporter

Playwright reporter that uploads results, screenshots, videos, and (via `playwright-snapshots`) trace-derived DOM snapshots.

## Commands

- `pnpm build` — `tsc` → `dist/`

## Entry points

- `.` → `dist/reporter.js` — the Playwright `Reporter` implementation.

Wired into consumer configs as:

```ts
// playwright.config.ts
reporter: [
  ["@flakeytesting/playwright-reporter", {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  }],
],
```

## Peer deps

- `@playwright/test >=1.30.0` (optional peer — the reporter is only useful alongside Playwright but we don't force install).

## Depends on

- `@flakeytesting/core` (workspace) — shared upload/format helpers.
- `@flakeytesting/playwright-snapshots` (workspace) — parses `.zip` trace files to extract DOM snapshots + command logs.

## Options + env-var fallbacks

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `url` | string | `FLAKEY_API_URL` env | Required. Backend base URL. |
| `apiKey` | string | `FLAKEY_API_KEY` env | Required. |
| `suite` | string | `FLAKEY_SUITE` env, then `"default"` | Suite name shown in the dashboard. |
| `branch` | string | env chain | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` |
| `commitSha` | string | env chain | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` |
| `ciRunId` | string | env chain | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` |
| `release` | string | `FLAKEY_RELEASE` env | Release version — backend upserts release + links run |
| `environment` | string | `FLAKEY_ENV` → `TEST_ENV` env | Target env label (e.g. `qa`, `stage`) — stored on `runs.environment` |

The env-var fallbacks for `url` / `apiKey` / `suite` make a credentials-via-env CI invocation (`reporter: ["@flakeytesting/playwright-reporter"]` with no options block) work without options — matching the live-reporter adapter pattern.

## Reporter metadata

The reporter captures: test title, full title path, pass/fail/skip status, duration, error message and stack, screenshot and video attachment paths, and (when traces are present) command logs extracted by `@flakeytesting/playwright-snapshots`. Fields such as retry count, tags, annotations, and stdout/stderr are not currently captured.
