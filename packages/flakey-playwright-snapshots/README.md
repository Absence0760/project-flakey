# @flakeytesting/playwright-snapshots

Internal helper used by [`@flakeytesting/playwright-reporter`](https://www.npmjs.com/package/@flakeytesting/playwright-reporter). Parses Playwright `.zip` trace files to extract DOM snapshots and command logs that the [Flakey](https://github.com/Absence0760/project-flakey) dashboard renders as a step-by-step scrubber.

## Install

You don't install this package directly. It's a dependency of `@flakeytesting/playwright-reporter` — the reporter pulls it in automatically when Playwright produces trace attachments. Adding it to your own `devDependencies` is unnecessary.

If you're building tooling on top of trace files and want the same parsing logic:

```bash
pnpm add -D @flakeytesting/playwright-snapshots
```

## How it works

Playwright produces a `trace.zip` per test when `trace: 'on'` (or `on-first-retry`) is set in `playwright.config.ts`. This package:

1. Reads the `.zip` entries that hold the network log, action log, and per-step DOM snapshots.
2. Converts them into the `SnapshotBundle` shape the Flakey dashboard expects — one entry per command step with HTML, viewport, scroll position, and command name.
3. Hands the bundle back to `@flakeytesting/playwright-reporter`, which uploads it alongside the run.

End-to-end consumers should enable Playwright tracing and call the reporter — there's no separate API to learn here.

## When you'd want it directly

- You're writing a different test reporter / dashboard and want to reuse the trace-parsing logic.
- You're debugging trace contents from the command line and want a programmatic shape.

For both, the exported `parseTrace(filePath: string): Promise<SnapshotBundle>` is the entry point.

## Compatibility

- Playwright: any version that produces v1.30+ trace format
- Node: 20+

## Links

- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
