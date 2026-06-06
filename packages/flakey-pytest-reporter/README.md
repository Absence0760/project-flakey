# flakey-pytest-reporter

A [pytest](https://pytest.org) plugin that uploads test results to a
[Flakey](https://flakey.io) backend — the first-class Python reporter
(alongside the JS reporters for Playwright / Cypress / Jest / WebdriverIO).

## Install

```bash
uv add flakey-pytest-reporter        # or: pip install flakey-pytest-reporter
```

The plugin auto-registers via pytest's entry-point system — no `-p` flag needed.

## Configure

Set the backend URL + an API key (create one in **Settings → API Keys**):

```bash
export FLAKEY_API_URL=https://flakey.your-company.com   # default http://localhost:3000
export FLAKEY_API_KEY=fk_...
export FLAKEY_SUITE=backend-unit                        # or pass --flakey-suite
pytest
```

On session finish the plugin POSTs a normalized run to `/runs`. If
`FLAKEY_API_KEY` is unset, pytest runs normally and nothing is uploaded.

### CI metadata

Branch / commit / CI-run-id are resolved from the same env chains as the other
reporters (first match wins):

| Field | Env chain |
|---|---|
| branch | `BRANCH` → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME` → `BITBUCKET_BRANCH` |
| commit | `COMMIT_SHA` → `GITHUB_SHA` → `BITBUCKET_COMMIT` |
| ci_run_id | `CI_RUN_ID` → `GITHUB_RUN_ID` → `BITBUCKET_BUILD_NUMBER` |

Optional: `FLAKEY_RELEASE` (links the run to a release), `FLAKEY_ENV` / `TEST_ENV`
(environment label).

## Status mapping

| pytest outcome | Flakey status |
|---|---|
| passed | `passed` |
| failed (incl. setup error) | `failed` |
| skipped / xfail | `skipped` |

pytest has no "pending" state, so `pending` is always 0.

## Scope (v0.1)

Results upload only — test outcomes, durations, error message + traceback,
keyed by source file. **Not yet** (follow-ups, mirroring the JS reporters):

- Live event streaming (`/live`) for the realtime dashboard.
- Artifact upload (screenshots/files) — pytest has no native artifact model;
  this will hook common plugins (e.g. `pytest-html` assets) later.

See `CLAUDE.md` for the plugin internals.
