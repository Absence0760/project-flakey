# @flakeytesting/playwright-snapshots

Parses Playwright trace `.zip` files and extracts command logs + DOM snapshots for the Flakey backend.

## Commands

- `pnpm build` — `tsc` → `dist/`

No dev/watch script; consumers rebuild `@flakeytesting/playwright-reporter` to pick up changes.

## Dependencies

- `adm-zip` — reads Playwright trace zip files. No alternative is wired in; don't swap it without updating the extraction paths.

## What's extracted

Per snapshot step (`SnapshotStep`): `commandName` / `commandMessage` (from the
action's method + cleaned selector), a DOM/screencast frame (`html`), and —
Phase 1 enrichment — optional `console[]` and `network[]`:

- **`console`** — `{ level, text }` from inline `type:"console"` events in the
  action trace. Playwright's `messageType:"warning"` is folded to `"warn"`.
- **`network`** — `{ method, url, status? }` from `type:"resource-snapshot"`
  entries in the **separate** network file (`trace.network` in 1.59; older
  builds used `*-network.trace` — both are read). A `status` of `-1`
  (request never completed) is omitted, not emitted.

`SnapshotStep.timestamp` is **milliseconds** since the run's first action — the
same unit the Cypress producer emits — so the dashboard can derive per-step
durations (gap between consecutive timestamps) and flag slow steps. (It once
multiplied by 1000, emitting microseconds; nothing consumed it then, but the
viewer now does, so the two producers must agree on ms.)

Each event is bucketed to the step that was **active** when it occurred — the
latest step whose action had started by the event's monotonic `time`
(console `time` / HAR `_monotonicTime` share the action clock). Events before
the first step fall to step 0. Per-step caps (`MAX_CONSOLE_PER_STEP = 100`,
`MAX_NETWORK_PER_STEP = 50`) bound bundle growth, mirroring the byte discipline
in `@flakeytesting/cypress-snapshots`. Both fields are **optional** — absent
when empty — so older bundles and the consumer stay backward-compatible.

## Consumers

- `@flakeytesting/playwright-reporter` (workspace) — only consumer. This package has no standalone CLI.

## Conventions

- Treat Playwright's trace format as an external contract — guard against missing/renamed fields rather than assuming layout. Trace internals have changed across Playwright versions.
- Keep the package browser-free and framework-free: pure Node, runs in a reporter context.
