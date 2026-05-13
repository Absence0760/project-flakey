# @flakeytesting/webdriverio-reporter

WebdriverIO reporter that uploads results, screenshots, and videos to the Flakey backend.

## Commands

- `pnpm build` — `tsc` → `dist/`

## Entry points

- `.` → `dist/reporter.js` — extends `@wdio/reporter`.

Wired into consumer configs as:

```ts
// wdio.conf.ts
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

export const config = {
  reporters: [[FlakeyReporter, {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  }]],
};
```

## Peer / deps

- `@wdio/reporter >=8.0.0` (required peer — base class). Moved from
  `dependencies` so consumers don't end up with a duplicate copy
  mismatching their wdio CLI version.
- `@wdio/types >=8.0.0` (optional peer — only needed for type info).
- `webdriverio >=8.0.0` (optional peer — listed for completeness).
- `@flakeytesting/core` (workspace) — shared upload/format helpers.

## Options

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `url` | string | `FLAKEY_API_URL` env | Required (option or env). Backend base URL. |
| `apiKey` | string | `FLAKEY_API_KEY` env | Required (option or env). |
| `suite` | string | `FLAKEY_SUITE` env, then `"default"` | Suite name shown in dashboard. |
| `branch` | string | env fallback | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` |
| `commitSha` | string | env fallback | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` |
| `ciRunId` | string | env fallback | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` |
| `release` | string | `FLAKEY_RELEASE` env | Release version — backend upserts release + links run |
| `environment` | string | `FLAKEY_ENV` → `TEST_ENV` env | Target env label (e.g. `qa`, `stage`) — stored on `runs.environment` |
| `screenshotsDir` | string | `"screenshots"` | Relative to cwd |
| `videosDir` | string | `"videos"` | Relative to cwd |

## Conventions

- Extend the `@wdio/reporter` base class; don't hand-roll the reporter lifecycle.
- Match the event normalization shape used by the cypress/playwright reporters so the backend can treat all three identically.
