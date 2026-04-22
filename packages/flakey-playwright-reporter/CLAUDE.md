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

## Reporter metadata

The reporter captures: test title, full title path, pass/fail/skip status, duration, error message and stack, screenshot and video attachment paths, and (when traces are present) command logs extracted by `@flakeytesting/playwright-snapshots`. Fields such as retry count, tags, annotations, and stdout/stderr are not currently captured.
