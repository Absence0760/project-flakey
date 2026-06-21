# flakey-pytest-reporter

First-class **pytest** reporter — the Python counterpart to the JS reporters.
Uploads results to the Flakey backend as a `NormalizedRun`. The reference
implementation for the Phase-14 "more native reporters" item (Go / .NET / RSpec
are follow-ups).

## Not in the pnpm workspace

This is a **Python** package (uv / hatchling), not an `@flakeytesting/*` npm
package. It has no `package.json`, so the pnpm workspace + `build:packages`
filter ignore it. Build/test it with `uv`, not pnpm.

## Layout (src layout)

- `src/flakey_pytest_reporter/plugin.py` — the pytest plugin. Pure helpers
  (`parse_nodeid`, `resolve_meta`, `build_run`) + the `FlakeyReporter` hook class.
- `src/flakey_pytest_reporter/uploader.py` — `post_run()`, a stdlib-only
  (`urllib`) POST to `/runs`. No `requests` dependency.
- `tests/test_plugin.py` — unit tests over the pure helpers + uploader (stubbed
  `urlopen`).

## Test

```bash
cd packages/flakey-pytest-reporter
PYTHONPATH=src uv run --with pytest python -m pytest tests/ -q
```

(`uv run` builds the package, so `README.md` must exist — hatchling reads it for
metadata.)

## How it maps to the contract

It POSTs a **pre-normalized** `NormalizedRun` directly to `POST /runs` — like the
Cypress/Playwright reporters, it needs **no backend normalizer** (the
`reporter: "pytest"` payload goes through the `{meta, stats, specs}` branch in
`backend/src/routes/runs.ts`, not `normalize()`).

- **nodeid → spec/test:** `file.py::Class::test[param]` → `file_path = file.py`,
  `full_title = "Class > test[param]"`, `title = "test[param]"`. One spec per
  source file.
- **Buffering:** `pytest_runtest_logreport` records once per test — the `call`
  phase for pass/fail, the `setup` phase only for skips / setup-errors (which
  never reach `call`). This avoids double-counting across phases. Entries are
  also keyed by `nodeid`, so a **rerun** (`pytest-rerunfailures` / `flaky`) of
  the same test overwrites its earlier attempt in place rather than appending a
  second row — final-attempt-wins, matching the JS reporters' retry handling.
  Without this a flaky test rerun 3× would report as 3 tests with phantom
  failures, corrupting the run's pass/fail counts and flaky detection.
- **Status:** pytest `passed`/`failed`/`skipped` map 1:1; there is no pending, so
  `stats.pending` is always 0.
- **Errors:** message from `longrepr.reprcrash.message` (falling back to the first
  line of `longreprtext`); full traceback in `error.stack`.
- **Upload:** `pytest_sessionfinish` builds the run and POSTs it. Any failure is
  caught and logged to stderr — an upload error **never** fails the test session.

## Env-var chains

`FLAKEY_API_URL` / `FLAKEY_API_KEY` / `FLAKEY_SUITE` (or `--flakey-suite`), plus
the standard branch/commit/ci-run-id chains and `FLAKEY_RELEASE` / `FLAKEY_ENV`
— see `README.md` for the table. No key → the plugin no-ops (pytest still runs).

## Publish

Published to **PyPI** (not npm) by the shared `.github/workflows/publish.yml`,
which builds with `uv build` and uploads via **Trusted Publishing (OIDC)** — no
token secret. It's on its **own version line** (`pyproject.toml`, currently
`0.1.0`) and is **not** part of the `all@` npm release: tag it
`pytest-reporter@<version>` (or use the `pytest-reporter` `workflow_dispatch`
choice). Bump `version` in `pyproject.toml`, merge to `main`, then publish a
GitHub release with that tag. **One-time PyPI setup** before the first publish:
add a pending publisher for project `flakey-pytest-reporter` → repo
`Absence0760/project-flakey`, workflow `publish.yml`, environment `production`
(the same GitHub Environment the npm publish jobs use — its required-reviewer
rule gates the PyPI publish too).

## Scope

Results upload only in v0.1. Live events (`/live`) + artifact upload are
follow-ups (pytest has no native artifact model).
