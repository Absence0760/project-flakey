# @flakeytesting/webdriverio-reporter

WebdriverIO reporter for the [Flakey](https://github.com/Absence0760/project-flakey) test reporting dashboard. Uploads results, screenshots, and videos.

## Install

```bash
pnpm add -D @flakeytesting/webdriverio-reporter
# or
npm install --save-dev @flakeytesting/webdriverio-reporter
```

Peer deps:

- `@wdio/reporter >=8.0.0` (required — base class)
- `@wdio/types >=8.0.0` (optional — type info only)
- `webdriverio >=8.0.0` (optional)

## Quick start

```ts
// wdio.conf.ts
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

export const config = {
  reporters: [
    ["spec"], // keep stdout output if you like
    [FlakeyReporter, {
      url:    process.env.FLAKEY_API_URL,
      apiKey: process.env.FLAKEY_API_KEY,
      suite:  "my-app-e2e",
    }],
  ],
  // ...rest of your wdio config
};
```

Then run:

```bash
FLAKEY_API_URL=https://flakey.your-domain.com \
FLAKEY_API_KEY=fk_xxx... \
wdio run wdio.conf.ts
```

The reporter buffers per-spec results and POSTs the complete run on `onRunnerEnd`. For live per-test events, additionally wire `@flakeytesting/live-reporter/webdriverio`.

## Options + env-var fallbacks

The reporter constructor reads any of these from `process.env` if the matching option is absent.

| Option | Type | Fallback | Notes |
|--------|------|----------|-------|
| `url` | string | `FLAKEY_API_URL` | Required (option or env). |
| `apiKey` | string | `FLAKEY_API_KEY` | Required. |
| `suite` | string | `FLAKEY_SUITE`, then `"default"` | Suite name shown in dashboard. |
| `branch` | string | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` | |
| `commitSha` | string | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` | |
| `ciRunId` | string | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` | |
| `release` | string | `FLAKEY_RELEASE` | Release version — backend upserts release + links run |
| `environment` | string | `FLAKEY_ENV` → `TEST_ENV` | Target env label (e.g. `qa`, `stage`) |
| `screenshotsDir` | string | `"screenshots"` | Relative to cwd |
| `videosDir` | string | `"videos"` | Relative to cwd |

## What gets captured

- Test title, full title (joined from `> ` parents), pass/fail/skip status, duration
- Error message + stack (preferring `test.error`, falling back to `test.errors[0]`)
- Screenshots from `screenshotsDir`, videos from `videosDir`

## Live streaming (optional)

For mid-run per-test events:

```ts
// wdio.conf.ts
import { register } from "@flakeytesting/live-reporter/webdriverio";

const liveReporter = register({
  url:    process.env.FLAKEY_API_URL,
  apiKey: process.env.FLAKEY_API_KEY,
  suite:  "my-app-e2e",
});

export const config = {
  reporters: [
    [liveReporter],
    [FlakeyReporter, { /* ... */ }],
  ],
};
```

## Compatibility

- WebdriverIO: `>=8.0.0`
- Node: 20+

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
