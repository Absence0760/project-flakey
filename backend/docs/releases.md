# Releases

A **release** is a gate between "we built something" and "we shipped
something". Better Testing tracks two side-by-side concerns per release:

1. **Readiness** — a checklist + auto-evaluated rules that decide
   whether sign-off is allowed.
2. **Test execution** — Xray-style test plan (linked manual tests) +
   test sessions (successive run attempts) so the same test plan can be
   executed multiple times with full history preserved.

## Linking tests to a release

A release is a "test plan" once you link manual tests to it. There are
three ways to do it:

- **+ Link tests** — pick one or many tests with a checkbox list.
- **+ Add by group** — bulk-link every test in a named group.
- Link individual runs from CI with **+ Link runs** on the automated
  runs panel.

Linked manual tests live in `release_manual_tests`; linked automated
runs live in `release_runs`.

## Test sessions

Each **session** is one run attempt of the release's linked tests.
Sessions are numbered sequentially per release (#1, #2, #3…) and have a
mode:

- `full` — seeds a result row for every linked manual test
- `failures_only` — seeds only the tests that were `failed` or
  `blocked` *and not yet accepted as a known issue* in the previous
  session

Exactly one session can be `in_progress` at a time; starting a new one
requires the current one to be marked complete.

```
GET  /releases/:id/sessions
POST /releases/:id/sessions                           — { label?, mode, target_date? }
GET  /releases/:id/sessions/:sid
PATCH /releases/:id/sessions/:sid                     — { label?, target_date?, status? }
POST /releases/:id/sessions/:sid/results/:testId      — { status, notes?, step_results? }
```

A session auto-completes when every result row reaches a terminal
status (i.e. no `not_run` rows remain).

### Accept-as-known-issue

A failed or blocked result can be explicitly **deferred** against a bug
reference. Acceptance:

- stops the result counting as a readiness blocker,
- drops the test out of the next `failures_only` session,
- keeps the record visible in history with the bug link.

```
POST   /releases/:id/sessions/:sid/results/:testId/accept   — { known_issue_ref? }
DELETE /releases/:id/sessions/:sid/results/:testId/accept   — revoke acceptance
```

### File a Jira bug from a failure

If Jira is configured for the org, a failed/blocked result can spawn a
Jira issue pre-filled with the test title, steps, recorded status, and
tester notes. The issue key is saved on the result row
(`filed_bug_key` / `filed_bug_url`) and surfaces as a red chip in the UI.
Pass `mark_known_issue: true` in the body to accept in the same call.

```
POST /releases/:id/sessions/:sid/results/:testId/file-bug
     { mark_known_issue?: boolean }
→ { key, url, already_filed }
```

Currently only Jira is wired up; GitHub/Linear support is a future
extension.

### Per-test evidence

Testers can attach screenshots, logs, or arbitrary files (≤ 20 MB each,
up to 20 per upload) to a session result. Files are stored via the
configured `Storage` backend (`uploads/evidence/<sid>/<testId>/…` on
local disk, keyed objects in S3) and metadata is persisted as a JSONB
array on `release_test_session_results.attachments`.

```
POST   /releases/:id/sessions/:sid/results/:testId/evidence   — multipart `files[]`
DELETE /releases/:id/sessions/:sid/results/:testId/evidence   — { key }
```

Deletion removes the metadata entry only; the underlying file is left
on the storage backend for audit (reaped via retention, not the API).

### Assignees

Each session result has an optional `assigned_to` user so a release
lead can divide a session across testers. Assign via:

```
POST /releases/:id/sessions/:sid/results/:testId/assign   — { user_id: number | null }
```

Assignments are surfaced as chips in the UI and returned by the session
detail endpoint as `assigned_to` + `assigned_to_email`.

## Readiness

`GET /releases/:id/readiness` returns live rollups for the release
page. Two rules are evaluated server-side on every read:

- `critical_tests_passing` — prefers runs linked via `release_runs`,
  else the latest run for the org; unmet whenever any failures remain.
- `manual_regression_executed` — uses the **most recent session**
  regardless of status:
  - unmet if any `failed`/`blocked`/`not_run` rows remain
    (accepted-as-known-issue failures don't count as blockers);
  - unmet while a session is in-progress even after all results are
    recorded — the release owner must `Mark session complete`
    explicitly before the rule turns green;
  - falls back to the flat `release_manual_tests` statuses if no
    session has been started, then to org-wide high/critical priority
    tests if no manual tests are linked.

The Manual Tests card on the readiness panel counts from the same
source (latest session if any, else flat linked tests), so its numbers
update in real time as testers record results.
