# Reporters & Normalizers

## Overview

Flakey supports multiple test reporters. Each reporter outputs a different format — the normalizer layer converts any supported format into a single unified schema so the rest of the app (database, API, frontend) doesn't care which reporter was used.

### Supported Reporters

| Reporter | Format | Test Frameworks | Status |
|---|---|---|---|
| **Mochawesome** | JSON | Cypress, Mocha | Implemented |
| **JUnit** | XML | Jest, pytest, PHPUnit, Go, Java, .NET, most CI systems | Implemented |
| **Playwright** | JSON | Playwright | Implemented |

## Usage

### CLI Upload

```bash
# Mochawesome (Cypress default)
flakey-upload \
  --reporter mochawesome \
  --report-dir cypress/reports \
  --suite my-e2e \
  --branch main

# JUnit XML
flakey-upload \
  --reporter junit \
  --report-dir test-results \
  --suite api-tests \
  --branch main

# Playwright JSON
flakey-upload \
  --reporter playwright \
  --report-dir playwright-report \
  --suite e2e-playwright \
  --branch main
```

### API Upload

POST raw report data to `/runs` with the `reporter` field set:

```bash
# JSON reporters (mochawesome, playwright)
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -d '{
    "meta": {
      "suite_name": "my-suite",
      "branch": "main",
      "commit_sha": "abc123",
      "ci_run_id": "ci-42",
      "started_at": "",
      "finished_at": "",
      "reporter": "playwright"
    },
    "raw": { ... }
  }'

# JUnit XML (pass XML as a string in the "raw" field)
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -d '{
    "meta": {
      "suite_name": "api-tests",
      "branch": "main",
      "commit_sha": "abc123",
      "ci_run_id": "ci-42",
      "started_at": "",
      "finished_at": "",
      "reporter": "junit"
    },
    "raw": "<?xml version=\"1.0\"?><testsuites>...</testsuites>"
  }'
```

## Unified Schema

All reporters are normalized into this structure before being stored:

```typescript
interface NormalizedRun {
  meta: {
    suite_name: string
    branch: string
    commit_sha: string
    ci_run_id: string
    started_at: string       // ISO 8601
    finished_at: string      // ISO 8601
    reporter: string         // "mochawesome" | "junit" | "playwright"
  }
  stats: {
    total: number
    passed: number
    failed: number
    skipped: number
    pending: number
    duration_ms: number
  }
  specs: NormalizedSpec[]
}

interface NormalizedSpec {
  file_path: string
  title: string
  stats: {
    total: number
    passed: number
    failed: number
    skipped: number
    duration_ms: number
  }
  tests: NormalizedTest[]
}

interface NormalizedTest {
  title: string
  full_title: string
  status: "passed" | "failed" | "skipped" | "pending"
  duration_ms: number
  error?: {
    message: string
    stack?: string
  }
  screenshot_paths: string[]
  video_path?: string
  test_code?: string
  command_log?: object[]
}
```

## Reporter Details

### Mochawesome

**Source:** `backend/src/normalizers/mochawesome.ts`

Mochawesome is the default reporter for Cypress. It outputs a JSON file with a nested suite/test structure.

**Input format:** JSON (`.json`)

**File discovery:** The CLI looks for `mochawesome.json` first, then falls back to any `.json` file in the report directory. Handles both single-file and merged formats (via `mochawesome-merge`).

**Mapping:**

| Mochawesome Field | Normalized Field |
|---|---|
| `stats.start` / `stats.end` | `meta.started_at` / `meta.finished_at` |
| `stats.passes` / `stats.failures` / `stats.pending` / `stats.skipped` | `stats.*` |
| `stats.duration` | `stats.duration_ms` |
| `results[]` | One `NormalizedSpec` per entry |
| `results[].file` or `results[].fullFile` | `spec.file_path` |
| `results[].suites[].tests[]` | `NormalizedTest[]` (recursively collected) |
| `test.pass` / `test.fail` / `test.pending` | `test.status` |
| `test.duration` | `test.duration_ms` |
| `test.err.message` / `test.err.estack` | `test.error.message` / `test.error.stack` |
| `test.code` | `test.test_code` |

**Generating reports:**

```bash
# cypress.config.ts
export default defineConfig({
  reporter: 'mochawesome',
  reporterOptions: {
    reportDir: 'cypress/reports',
    overwrite: false,
    html: false,
    json: true,
  },
});

# After running tests, merge reports:
npx mochawesome-merge cypress/reports/*.json > cypress/reports/mochawesome.json
```

---

### JUnit XML

**Source:** `backend/src/normalizers/junit.ts`

JUnit XML is the most widely supported test result format. Nearly every test framework and CI system can produce or consume it.

**Input format:** XML (`.xml`)

**Dependencies:** `fast-xml-parser` for XML parsing.

**File discovery:** The CLI looks for any `.xml` file in the report directory.

**Supported XML structures:**

```xml
<!-- Wrapped in <testsuites> (most common) -->
<testsuites tests="10" failures="2" errors="0" time="5.2">
  <testsuite name="UserAPI" tests="5" failures="1" file="tests/user.test.ts">
    <testcase name="should list users" classname="UserAPI" time="0.12"/>
    <testcase name="should validate input" classname="UserAPI" time="0.25">
      <failure message="Expected 400">Stack trace here</failure>
    </testcase>
    <testcase name="should skip old test" classname="UserAPI">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>

<!-- Standalone <testsuite> (also supported) -->
<testsuite name="AuthTests" tests="3" failures="0">
  <testcase name="login" classname="AuthTests" time="0.5"/>
</testsuite>
```

**Mapping:**

| JUnit Element/Attribute | Normalized Field |
|---|---|
| `<testsuite name>` | `spec.title` |
| `<testsuite file>` | `spec.file_path` (falls back to `name`) |
| `<testcase name>` | `test.title` |
| `<testcase classname>` + `name` | `test.full_title` |
| `<testcase time>` (seconds) | `test.duration_ms` (converted to ms) |
| No child elements | `status: "passed"` |
| `<failure message="...">text</failure>` | `status: "failed"`, `error.message`, `error.stack` |
| `<error message="...">text</error>` | `status: "failed"`, `error.message`, `error.stack` |
| `<skipped/>` | `status: "skipped"` |

**Generating reports by framework:**

```bash
# Jest
jest --reporters=jest-junit
# Output: junit.xml

# pytest
pytest --junitxml=results.xml

# Go
go test -v ./... 2>&1 | go-junit-report > results.xml

# PHPUnit
phpunit --log-junit results.xml

# .NET
dotnet test --logger "junit;LogFilePath=results.xml"

# Java (Maven)
mvn test  # Surefire generates XML in target/surefire-reports/
```

---

### Playwright JSON

**Source:** `backend/src/normalizers/playwright.ts`

Playwright's built-in JSON reporter produces a structured report with suites, specs, tests, and results.

**Input format:** JSON (`.json`)

**File discovery:** The CLI looks for `results.json` first, then falls back to any `.json` file in the report directory.

**Key behaviors:**

- **Retries:** Playwright may produce multiple results per test (retries). The normalizer uses the **last result** (the final attempt).
- **Status mapping:** `passed` and `skipped` map directly. `failed`, `timedOut`, and `interrupted` all map to `failed`.
- **Attachments:** Screenshots and videos are extracted from the `attachments` array by content type (`image/*` → screenshots, `video/*` → video).
- **Nested suites:** Playwright nests suites by `describe()` blocks. The normalizer walks the tree recursively and groups tests by source file.

**Mapping:**

| Playwright Field | Normalized Field |
|---|---|
| `stats.startTime` | `meta.started_at` |
| `stats.duration` | `stats.duration_ms` |
| `suites[].file` | `spec.file_path` |
| `suites[].specs[].title` | `test.title` |
| Suite title path joined with ` > ` | `test.full_title` |
| `result.status` | `test.status` (timedOut/interrupted → failed) |
| `result.duration` | `test.duration_ms` |
| `result.error.message` / `.stack` | `test.error.message` / `.stack` |
| `result.attachments` (image/*) | `test.screenshot_paths` |
| `result.attachments` (video/*) | `test.video_path` |

**Generating reports:**

```bash
# playwright.config.ts
export default defineConfig({
  reporter: [
    ['json', { outputFile: 'playwright-report/results.json' }],
    ['html'],  # optional: keep the HTML report too
  ],
});

# Or via CLI
npx playwright test --reporter=json > playwright-report/results.json
```

---

## Adding a New Reporter

1. Create `backend/src/normalizers/{reporter-name}.ts`
2. Export a `parse{ReporterName}(raw, meta) => NormalizedRun` function
3. Register it in `backend/src/normalizers/index.ts`:
   ```typescript
   import { parseMyReporter } from "./my-reporter.js";

   const parsers: Record<string, Parser> = {
     mochawesome: parseMochawesome as Parser,
     junit: parseJUnit as Parser,
     playwright: parsePlaywright as Parser,
     "my-reporter": parseMyReporter as Parser,  // add here
   };
   ```
4. Update `cli/src/index.ts` `findReportFile()` to handle the new reporter's file format
5. Test with a real report file from the target framework

The normalizer should:
- Handle missing/optional fields gracefully with sensible defaults
- Convert all durations to milliseconds
- Convert all timestamps to ISO 8601 strings
- Compute spec-level stats from individual test results
- Set `reporter` in meta to the reporter name
