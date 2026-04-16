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

Both now return `source`, `source_ref`, `source_file`, `auto_last_status`,
and `auto_last_run_at` in addition to the existing fields.
