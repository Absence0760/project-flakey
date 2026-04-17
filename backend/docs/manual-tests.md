# Manual tests

Better Testing's **manual tests** view is a lightweight Xray-style test case
inventory. Tests can come from two sources:

| Source       | How it's created                                    | Who owns it        |
| ------------ | --------------------------------------------------- | ------------------ |
| **Manual**   | Hand-authored via the UI ("+ New test")             | QA, in the app     |
| **Cucumber** | Imported from a `.feature` file                     | The automation repo |

Both kinds live in the same `manual_tests` table and show up in the same
list, filters, and summary counts — but behave differently based on their
origin.

## Hand-authored manual tests

Click **+ New test** to open the Xray-style editor: a Details section plus
a step grid with Action / Data / Expected result per row. Tests are
free-form and can be linked to an automated spec via the "Linked automated
test" combobox.

These are fully editable in the UI. Results are recorded manually with
Passed / Failed / Blocked / Skipped.

## Imported Cucumber scenarios

If your team already has automated Cucumber coverage, you don't need to
retype the scenarios as manual cases. Click **⇪ Import .feature files**
and select one or more `.feature` files. Every scenario becomes a manual
test with:

- `title` = scenario name
- `suite_name` = feature name
- `steps` = background + scenario steps, with `Then` clauses rendered in
  the **Expected result** column and `Given`/`When` in **Action**
- `tags` = Gherkin `@tags` (with the `@` stripped)
- `source` = `cucumber`
- `source_ref` = `<path>::<scenario name>` (the re-import key)
- `source_file` = the file path as uploaded

**Scenario Outlines** are expanded into one manual test per `Examples:`
row, so each concrete case is tracked separately.

### Re-importing

Imports are idempotent. Re-running the same import updates existing rows
in place — renames of step wording, reordering, or added/removed tags
propagate automatically. Renaming a *scenario* produces a new manual
test (the old one will stick around under its previous title until
deleted).

### Read-only

Imported scenarios are owned by the feature file. The UI blocks editing
them and the `PATCH /manual-tests/:id` endpoint returns `409 Conflict`
for `source = 'cucumber'` rows. The fix is always: change the
`.feature` file, re-import.

### Automation status

Because imported scenarios are executed on every CI run, Better Testing joins
each one against the most recent matching automated test (by
`file_path` and scenario title) and displays the result:

- An **Automated** badge in the list, with a green/red dot reflecting
  the last automated pass/fail
- In the detail modal, a green "Covered by automation — you do not
  need to run this manually" banner
- The "Record result" form is hidden — the result comes from the
  automation pipeline, not a human tester

If no matching automated test has been uploaded yet, the badge shows a
neutral dot and the banner reads "No automated run yet".

## API

```
POST /manual-tests/import-features
{
  "files": [
    { "path": "cypress/e2e/login.feature", "content": "Feature: ..." }
  ]
}
→ { "created": 3, "updated": 2, "scanned": 5, "errors": [] }
```

The client reads files in the browser and sends `{path, content}` pairs.
`path` becomes the `source_file` value and is displayed in the detail
banner, so prefer repo-relative paths (Better Testing uses `webkitRelativePath`
when a directory is selected).

```
GET /manual-tests
GET /manual-tests/:id
```

Both return `source`, `source_ref`, `source_file`, `auto_last_status`,
`auto_last_run_at`, `group_id`, `group_name`, `requirement_count`,
`total_runs`, `failure_count`, `pass_rate`, and `is_flaky` in addition
to the hand-authored fields. `GET /manual-tests/:id` also returns a
`requirements` array.

## Groups

Manual tests can be organised into **groups** — named collections like
"Checkout Flow" or "Auth Suite" — so a whole group can be bulk-linked to
a release in one click. Groups are per-org and free-form; a test belongs
to at most one group (`manual_tests.group_id`).

```
GET    /manual-test-groups            — list with test counts
POST   /manual-test-groups            — { name, description? }
GET    /manual-test-groups/:id        — detail + members
PATCH  /manual-test-groups/:id        — rename / update description
DELETE /manual-test-groups/:id        — drops the group, sets member group_id = NULL

POST   /releases/:id/manual-test-groups/:groupId
   → bulk-links every test in the group to the release;
     already-linked tests are skipped via ON CONFLICT.
```

Creating/editing a test accepts `group_id` in the request body; passing
`null` removes the assignment. The list endpoint supports `?group_id=N`
to filter by a group and `?group_id=none` to return only ungrouped tests.

## Requirements traceability

Each manual test can be linked to one or more **requirements** —
identifiers (and optional URLs) in Jira / GitHub / Linear / other —
so release readiness can show "Story ABC-42 → 3 tests, 2 passing".
The provider is inferred from the URL when not set explicitly.

```
GET    /manual-tests/:id/requirements
POST   /manual-tests/:id/requirements          — { ref_key, ref_url?, ref_title?, provider? }
DELETE /manual-tests/:id/requirements/:reqId

GET    /releases/:id/requirements
   → rollup: for every requirement linked by a test that's also linked to
     this release, return passed/failed/blocked/not-run counts derived
     from the latest session's results.
```

## Flakiness

Once a test has ≥ 2 recorded results across `release_test_session_results`,
the list endpoint surfaces:

- `total_runs` — executed results (passed + failed)
- `failure_count` — number of failures
- `pass_rate` — decimal 0–1 (null if fewer than 2 runs)
- `is_flaky` — boolean; true when pass rate is strictly between 0 and 1

The UI uses `is_flaky` to render a small `flaky` badge next to the test
title and a pass-rate chip in the table's Signal column, and a "Flaky
only" filter appears in the toolbar whenever at least one test has the
flag set. This is computed live from history — no ingest job required.
