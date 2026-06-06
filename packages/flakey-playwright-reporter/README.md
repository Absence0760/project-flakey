# @flakeytesting/playwright-reporter

Playwright reporter for the [Flakey](https://github.com/Absence0760/project-flakey) test reporting dashboard. Uploads results, screenshots, videos, and DOM snapshots extracted from Playwright traces.

## Install

```bash
pnpm add -D @flakeytesting/playwright-reporter
# or
npm install --save-dev @flakeytesting/playwright-reporter
```

`@playwright/test` is an optional peer (`>=1.30.0`) — the reporter is only useful alongside Playwright.

## Quick start

Add the reporter to your `playwright.config.ts`:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["@flakeytesting/playwright-reporter", {
      url:    process.env.FLAKEY_API_URL,
      apiKey: process.env.FLAKEY_API_KEY,
      suite:  "my-app-e2e",
    }],
    ["list"], // keep stdout output too if you like
  ],
});
```

Then run as usual:

```bash
FLAKEY_API_URL=https://flakey.your-domain.com \
FLAKEY_API_KEY=fk_xxx... \
playwright test
```

The reporter posts everything in one batched upload at end-of-run. For live per-test events, additionally wire `@flakeytesting/live-reporter/playwright`.

## What gets captured

- Test title, full title path, pass/fail/skip status, duration
- Error message + stack
- Screenshots and videos (Playwright attachments — `image/*` / `video/*`)
- Command logs + DOM snapshots extracted from `.zip` trace attachments (via `@flakeytesting/playwright-snapshots`, an internal dep — you don't install it separately)

Retry handling: a failed test that has more retries left is dropped from the upload; only the final outcome reaches the dashboard. So the counts in Flakey match `pass`/`fail`/`flaky` as Playwright itself reports them.

## Options + env-var fallbacks

The reporter constructor reads any of these from `process.env` if the matching option is absent. Options always win.

| Option | Type | Fallback | Notes |
|--------|------|----------|-------|
| `url` | string | `FLAKEY_API_URL` | Required (option or env). Backend base URL. |
| `apiKey` | string | `FLAKEY_API_KEY` | Required. |
| `suite` | string | `FLAKEY_SUITE`, then `"default"` | Suite name shown in dashboard. |
| `branch` | string | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` | |
| `commitSha` | string | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` | |
| `ciRunId` | string | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` | |
| `release` | string | `FLAKEY_RELEASE` | Release version — backend upserts release + links run |
| `environment` | string | `FLAKEY_ENV` → `TEST_ENV` | Target env label (e.g. `qa`, `stage`) — stored on `runs.environment` |

## Live streaming (optional)

For mid-run per-test events (so the dashboard updates as the suite runs):

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["@flakeytesting/playwright-reporter", { /* ... */ }],
    ["@flakeytesting/live-reporter/playwright", {
      url:    process.env.FLAKEY_API_URL,
      apiKey: process.env.FLAKEY_API_KEY,
      suite:  "my-app-e2e",
    }],
  ],
});
```

## Compatibility

- Playwright: `>=1.30.0` (optional peer)
- Node: 20+

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
