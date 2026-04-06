# Architecture

## Stack

| Layer | Technology |
|---|---|
| Test runner | Cypress (or any framework) |
| Reporters | mochawesome, JUnit XML |
| Upload CLI | Node.js CLI script |
| Backend API | Node.js + Express |
| Normalizer | Per-reporter parser → unified schema |
| Database | PostgreSQL |
| Frontend | Svelte |

## System flow

```
Cypress test run completes
        ↓
Reporter generates output (mochawesome JSON / JUnit XML)
        ↓
Node CLI reads output files + metadata
        ↓
POST to backend API
        ↓
Normalizer converts format → unified schema
        ↓
Store in PostgreSQL
        ↓
Svelte dashboard reads from API → displays results
```

## Component breakdown

### 1. CLI uploader
- Reads mochawesome JSON or JUnit XML from the output directory
- Collects run metadata (branch, commit SHA, CI run ID, suite name, timestamps)
- POSTs to the backend API
- Runs as a post-step in your CI pipeline

### 2. Backend API (Express)
- `POST /runs` — receives report payload
- `GET /runs` — list runs with filters (branch, suite, date range)
- `GET /runs/:id` — single run detail
- `GET /suites` — suite list
- `GET /specs/:name/history` — flakiness history for a spec

### 3. Normalizer
Each reporter has its own parser that converts to a unified internal schema. See `normalizer.md` for the schema definition and parser details.

### 4. PostgreSQL schema (simplified)

```sql
runs (
  id, suite_name, branch, commit_sha, ci_run_id,
  started_at, finished_at, total, passed, failed, skipped, duration_ms
)

specs (
  id, run_id, file_path, title,
  passed, failed, skipped, duration_ms
)

tests (
  id, spec_id, title, status, duration_ms,
  error_message, screenshot_path, video_path
)
```

### 5. Svelte frontend
- Run list view with filters (branch, suite, date)
- Run detail view (spec tree, pass/fail per test)
- Flakiness view (tests that flip between pass/fail across runs)
- Trend charts (pass rate over time per suite)

## CI integration examples

### Bitbucket Pipelines
```yaml
- step:
    name: Upload test results
    script:
      - node scripts/upload-results.js
    after-script:
      - node scripts/upload-results.js  # runs even on failure
```

### GitHub Actions
```yaml
- name: Upload test results
  if: always()
  run: node scripts/upload-results.js
  env:
    DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}
    DASHBOARD_TOKEN: ${{ secrets.DASHBOARD_TOKEN }}
```
