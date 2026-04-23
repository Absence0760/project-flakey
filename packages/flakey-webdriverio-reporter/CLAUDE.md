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

- `@wdio/types >=8.0.0` (optional peer — only needed for type info).
- `@wdio/reporter` (direct dep) — base class.
- `@flakeytesting/core` (workspace) — shared upload/format helpers.

## Options

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `url` | string | — | Required. Backend base URL. |
| `apiKey` | string | — | Required. |
| `suite` | string | — | Required. Suite name shown in dashboard. |
| `branch` | string | env fallback | `BRANCH` → `GITHUB_REF_NAME` |
| `commitSha` | string | env fallback | `COMMIT_SHA` → `GITHUB_SHA` |
| `ciRunId` | string | env fallback | `CI_RUN_ID` → `GITHUB_RUN_ID` |
| `release` | string | `FLAKEY_RELEASE` env | Release version — backend upserts release + links run |
| `screenshotsDir` | string | `"screenshots"` | Relative to cwd |
| `videosDir` | string | `"videos"` | Relative to cwd |

## Conventions

- Extend the `@wdio/reporter` base class; don't hand-roll the reporter lifecycle.
- Match the event normalization shape used by the cypress/playwright reporters so the backend can treat all three identically.
