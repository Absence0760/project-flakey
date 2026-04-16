# @flakeytesting/playwright-snapshots

Parses Playwright trace `.zip` files and extracts command logs + DOM snapshots for the Flakey backend.

## Commands

- `pnpm build` — `tsc` → `dist/`

No dev/watch script; consumers rebuild `@flakeytesting/playwright-reporter` to pick up changes.

## Dependencies

- `adm-zip` — reads Playwright trace zip files. No alternative is wired in; don't swap it without updating the extraction paths.

## Consumers

- `@flakeytesting/playwright-reporter` (workspace) — only consumer. This package has no standalone CLI.

## Conventions

- Treat Playwright's trace format as an external contract — guard against missing/renamed fields rather than assuming layout. Trace internals have changed across Playwright versions.
- Keep the package browser-free and framework-free: pure Node, runs in a reporter context.
