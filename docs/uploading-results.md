# Uploading Test Results

This guide covers how to get test results from your test framework into Flakey, including screenshots and videos.

## Prerequisites

- Flakey backend running (default: `http://localhost:3000`)
- An authenticated user — either a JWT token or an API key

### Getting a token (quick)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@flakey.dev","password":"admin"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
```

### Getting an API key (recommended for CI)

1. Log in at http://localhost:7777
2. Go to **Settings** in the sidebar
3. Under **API Keys**, enter a label and click **Create key**
4. Copy the key (starts with `fk_`) — it's only shown once

---

## Method 1: Direct Reporter (recommended)

The simplest way to get results into Flakey. Install the reporter package, add it to your config, and results are uploaded automatically when the run finishes — including screenshots, videos, and DOM snapshots. No extra steps.

### Cypress

```bash
npm install --save-dev @flakeytesting/cypress-reporter @flakeytesting/cypress-snapshots
```

```typescript
// cypress.config.ts
import { defineConfig } from "cypress";
import { flakeyReporter } from "@flakeytesting/cypress-reporter/plugin";
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  },
  e2e: {
    setupNodeEvents(on, config) {
      flakeyReporter(on, config);
      flakeySnapshots(on, config);  // optional: DOM snapshot capture
      return config;
    },
  },
});
```

```typescript
// cypress/support/e2e.ts
import "@flakeytesting/cypress-reporter/support";
import "@flakeytesting/cypress-snapshots/support";  // only if using snapshots
```

Then just run your tests:

```bash
FLAKEY_API_KEY=fk_your_key npx cypress run
```

Everything is uploaded in a single request after the run finishes — report, screenshots, videos, and DOM snapshots. One run, no merge step, no CLI.

### Playwright

```bash
npm install --save-dev @flakeytesting/playwright-reporter
```

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["@flakeytesting/playwright-reporter", {
      url: "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY,
      suite: "my-project",
    }],
  ],
});
```

### WebdriverIO

```bash
npm install --save-dev @flakeytesting/webdriverio-reporter
```

```typescript
// wdio.conf.ts
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

export const config = {
  reporters: [[FlakeyReporter, {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "my-project",
  }]],
};
```

---

## Method 2: CLI Uploader

The CLI finds report files, discovers screenshots and videos, matches them to tests, and uploads everything in one multipart request.

### Cypress + Mochawesome

```bash
# From your Cypress project root:
npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
  --report-dir cypress/reports \
  --screenshots-dir cypress/screenshots \
  --videos-dir cypress/videos \
  --suite my-project \
  --branch main \
  --reporter mochawesome \
  --api-key fk_your_key_here
```

The `--screenshots-dir` and `--videos-dir` default to `cypress/screenshots` and `cypress/videos`, so if your project uses the standard layout:

```bash
npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
  --report-dir cypress/reports \
  --suite my-project \
  --api-key fk_your_key_here
```

### Playwright

```bash
npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
  --report-dir playwright-report \
  --suite my-playwright-tests \
  --reporter playwright \
  --api-key fk_your_key_here
```

For Playwright, you **don't need** `--screenshots-dir` or `--videos-dir`. The CLI reads the JSON report and automatically extracts all screenshot and video file paths from the `attachments` field in each test result. It resolves both absolute and relative paths, then uploads the files alongside the report.

Playwright records videos as `.webm` by default — this format is fully supported.

### JUnit XML (Jest, pytest, Go, etc.)

```bash
npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
  --report-dir test-results \
  --suite api-tests \
  --reporter junit \
  --api-key fk_your_key_here
```

### Using environment variables

Instead of flags, you can use env vars (useful in CI):

```bash
export FLAKEY_API_URL=http://localhost:3000
export FLAKEY_API_KEY=fk_your_key_here

npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
  --report-dir cypress/reports \
  --suite my-project
```

### CLI flags reference

| Flag | Default | Description |
|---|---|---|
| `--report-dir` | `cypress/reports` | Directory containing report files |
| `--suite` | `default` | Suite name (groups runs in the UI) |
| `--branch` | `$BRANCH` env | Git branch |
| `--commit` | `$COMMIT_SHA` env | Git commit SHA |
| `--ci-run-id` | `$CI_RUN_ID` env | CI pipeline run ID |
| `--reporter` | `mochawesome` | Reporter format: `mochawesome`, `junit`, or `playwright` |
| `--screenshots-dir` | `cypress/screenshots` | Directory to search for `.png` files (not needed for Playwright) |
| `--videos-dir` | `cypress/videos` | Directory to search for `.mp4`/`.webm` files (not needed for Playwright) |
| `--api-key` | `$FLAKEY_API_KEY` env | Authentication token (JWT or API key) |

---

## Method 2: curl (JSON only, no artifacts)

For quick uploads without screenshots/videos:

```bash
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"meta\": {
      \"suite_name\": \"my-project\",
      \"branch\": \"main\",
      \"commit_sha\": \"\",
      \"ci_run_id\": \"\",
      \"started_at\": \"\",
      \"finished_at\": \"\",
      \"reporter\": \"mochawesome\"
    },
    \"raw\": $(cat cypress/reports/mochawesome.json)
  }"
```

For JUnit XML, pass the XML as a string:

```bash
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"meta\": {
      \"suite_name\": \"api-tests\",
      \"branch\": \"main\",
      \"commit_sha\": \"\",
      \"ci_run_id\": \"\",
      \"started_at\": \"\",
      \"finished_at\": \"\",
      \"reporter\": \"junit\"
    },
    \"raw\": $(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' < test-results/junit.xml)
  }"
```

---

## Method 3: curl with multipart (with artifacts)

To include screenshots and videos via curl:

```bash
curl -X POST http://localhost:3000/runs/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "payload={
    \"meta\": {
      \"suite_name\": \"my-project\",
      \"branch\": \"main\",
      \"commit_sha\": \"\",
      \"ci_run_id\": \"\",
      \"started_at\": \"\",
      \"finished_at\": \"\",
      \"reporter\": \"mochawesome\"
    },
    \"raw\": $(cat cypress/reports/mochawesome.json)
  }" \
  -F "screenshots=@cypress/screenshots/my-test (failed).png" \
  -F "videos=@cypress/videos/spec.mp4"
```

---

## How screenshots and videos are handled

Each reporter handles artifacts differently. Flakey supports all of them automatically.

### Per-reporter artifact handling

| Reporter | Screenshots | Videos | How artifacts are found |
|---|---|---|---|
| **Mochawesome (Cypress)** | On failure, saved to `cypress/screenshots/` | Per-spec `.mp4` in `cypress/videos/` | CLI scans `--screenshots-dir` and `--videos-dir` |
| **Playwright** | On failure + custom `page.screenshot()`, saved as attachments | Per-spec `.webm` as attachments | CLI reads attachment paths from the JSON report automatically |
| **JUnit** | Not built-in (framework-dependent) | Not built-in | CLI scans `--screenshots-dir` and `--videos-dir` if provided |

### Playwright attachments

Playwright embeds screenshot and video paths in its JSON report under `result.attachments`:

```json
{
  "attachments": [
    { "name": "screenshot", "contentType": "image/png", "path": "test-results/login-test/screenshot.png" },
    { "name": "video", "contentType": "video/webm", "path": "test-results/login-test/video.webm" }
  ]
}
```

The CLI automatically:
1. Walks the JSON report and extracts all attachment file paths
2. Resolves relative paths (relative to the report file) and absolute paths
3. Checks that the files exist on disk
4. Uploads them as part of the multipart request

You don't need to specify `--screenshots-dir` or `--videos-dir` for Playwright — it's all handled from the report.

### Cypress screenshot matching

Cypress saves screenshots with filenames like:

```
Suite Name -- Nested Describe -- test title (failed).png
```

The backend matches these to tests using a normalized substring algorithm:

1. **Full title match (preferred)** — strips both the filename and `full_title` to lowercase alphanumeric, checks if one is a substring of the other. This includes the suite path so it's very specific.
2. **Short title fallback (disabled for short names)** — the bare `title` is checked only if it's at least 15 characters, preventing false positives like "Login" matching "Login with SSO (failed).png".
3. **Basename match (Playwright fallback)** — if title matching fails, the backend checks if any uploaded file's name matches the basename of the original attachment path from the report.

### Videos

- **Cypress** records one `.mp4` per spec file — assigned to all tests in that spec
- **Playwright** records one `.webm` per spec file — linked via the report's attachments
- Both formats are supported by the video player in the UI

### Storage

All artifacts are stored per-run in isolated directories:

```
uploads/
  runs/
    42/
      screenshots/
        test-name (failed).png
      videos/
        spec-file.mp4
    43/
      screenshots/
        ...
```

No cross-run confusion even with identical test names.

### Viewing artifacts in the UI

Any test with a video, screenshot, or error message is clickable in the run detail view. Clicking opens a detail modal with:

- **Screenshot tab** — shows when the test has screenshots. Click to view in a zoomable/pannable lightbox with keyboard navigation.
- **Video tab** — shows when the test has a video (`.mp4` or `.webm`). Available for both passing and failing tests.
- **Error tab** — error message, expandable stack trace, and code snippet (Playwright).
- **Commands tab** — command log steps with pass/fail indicators.
- **Source tab** — test source code (if captured).
- **Details tab** — reporter-specific metadata: retry history, annotations, tags, stdout/stderr, properties (Playwright and JUnit only).

The modal auto-selects the most relevant tab: screenshots if available, then video, then error, then details.

### Tips

- Cypress only captures screenshots on failure by default. Passing tests will only have the Video tab.
- Playwright captures screenshots on failure by default. You can capture on every test with `screenshot: 'on'` in the config.
- For JUnit, screenshots are not built-in — you'll need a framework-specific plugin and pass the directory via `--screenshots-dir`.

---

## Generating reports (for CLI method only)

If using the direct reporter (Method 1), skip this section — no report generation is needed.

### Cypress + Mochawesome

Install the reporter:

```bash
npm install --save-dev mochawesome mochawesome-merge
```

Configure in `cypress.config.ts`:

```typescript
export default defineConfig({
  reporter: 'mochawesome',
  reporterOptions: {
    reportDir: 'cypress/reports',
    overwrite: false,
    html: false,
    json: true,
  },
});
```

After running tests, merge the per-spec reports:

```bash
npx cypress run
npx mochawesome-merge cypress/reports/*.json > cypress/reports/mochawesome.json
```

If your reports end up in a `mochawesome/` subdirectory (common with default config), use:

```bash
npx mochawesome-merge cypress/reports/mochawesome/*.json > cypress/reports/mochawesome.json
```

### Playwright

Configure in `playwright.config.ts`:

```typescript
export default defineConfig({
  reporter: [
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
});
```

Then run:

```bash
npx playwright test
```

### Jest (JUnit)

```bash
npm install --save-dev jest-junit
```

```bash
JEST_JUNIT_OUTPUT_DIR=test-results jest --reporters=jest-junit
```

### pytest (JUnit)

```bash
pytest --junitxml=test-results/results.xml
```

### Go (JUnit)

```bash
go install github.com/jstemmer/go-junit-report/v2@latest
go test -v ./... 2>&1 | go-junit-report > test-results/results.xml
```

---

## CI integration

### GitHub Actions

```yaml
- name: Run Cypress tests
  run: npx cypress run

- name: Merge reports
  if: always()
  run: npx mochawesome-merge cypress/reports/*.json > cypress/reports/mochawesome.json

- name: Upload to Flakey
  if: always()
  run: |
    npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts \
      --report-dir cypress/reports \
      --suite my-project \
      --branch ${{ github.ref_name }} \
      --commit ${{ github.sha }} \
      --ci-run-id ${{ github.run_id }}
  env:
    FLAKEY_API_URL: ${{ secrets.FLAKEY_API_URL }}
    FLAKEY_API_KEY: ${{ secrets.FLAKEY_API_KEY }}
```

### Bitbucket Pipelines

```yaml
- step:
    name: Test & upload
    script:
      - npx cypress run
      - npx mochawesome-merge cypress/reports/*.json > cypress/reports/mochawesome.json
    after-script:
      - npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts
          --report-dir cypress/reports
          --suite my-project
          --branch $BITBUCKET_BRANCH
          --commit $BITBUCKET_COMMIT
          --ci-run-id $BITBUCKET_BUILD_NUMBER
          --api-key $FLAKEY_API_KEY
```

The `after-script` block runs even if tests fail, ensuring results are always uploaded.

### GitLab CI

```yaml
test:
  script:
    - npx cypress run
    - npx mochawesome-merge cypress/reports/*.json > cypress/reports/mochawesome.json
  after_script:
    - npx tsx /path/to/flakey/packages/flakey-cli/src/index.ts
        --report-dir cypress/reports
        --suite my-project
        --branch $CI_COMMIT_REF_NAME
        --commit $CI_COMMIT_SHA
        --ci-run-id $CI_PIPELINE_ID
        --api-key $FLAKEY_API_KEY
  artifacts:
    when: always
    paths:
      - cypress/reports/
      - cypress/screenshots/
      - cypress/videos/
```

---

## Parallel CI Runs

When running tests across multiple CI workers (e.g. GitHub Actions matrix), each worker uploads separately. Flakey automatically merges uploads with the same `ci_run_id` + `suite_name` into a single run.

The `ci_run_id` is picked up automatically from CI environment variables:

| CI Platform | Environment Variable |
|---|---|
| GitHub Actions | `GITHUB_RUN_ID` |
| GitLab CI | `CI_PIPELINE_ID` |
| Bitbucket Pipelines | `BITBUCKET_BUILD_NUMBER` |
| CircleCI | `CIRCLE_WORKFLOW_ID` |
| Jenkins | `BUILD_ID` |

### Example: GitHub Actions matrix

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx cypress run --spec $(curl -s "$FLAKEY_URL/predict/split?suite=e2e&workers=4" -H "Authorization: Bearer $FLAKEY_KEY" | jq -r ".workers[${{ matrix.shard - 1 }}].specs | join(\",\")")
```

All 4 shards share the same `GITHUB_RUN_ID`, so their uploads merge into one run in Flakey.

### Smart spec balancing

Instead of splitting specs evenly, use `GET /predict/split` to balance by historical duration:

```bash
curl "http://localhost:3000/predict/split?suite=my-suite&workers=4" \
  -H "Authorization: Bearer fk_your_key"
```

Returns spec assignments per worker with estimated duration.

---

## Live Reporting

Stream test progress to Flakey in real-time during execution using `@flakeytesting/live-reporter`.

### Cypress setup

```bash
npm install --save-dev @flakeytesting/live-reporter
```

```typescript
// cypress.config.ts
import { register as registerLive } from "@flakeytesting/live-reporter/dist/mocha.js";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      registerLive(on, {
        url: process.env.FLAKEY_API_URL ?? "http://localhost:3000",
        apiKey: process.env.FLAKEY_API_KEY ?? "",
        suite: "my-suite",
      });
      return config;
    },
  },
});
```

### Playwright setup

```typescript
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["@flakeytesting/playwright-reporter", { url, apiKey, suite }],
    ["@flakeytesting/live-reporter/playwright", { url, apiKey }],
  ],
});
```

The live reporter creates a placeholder run immediately so it appears in the dashboard. Test results stream in as each spec finishes. The main reporter's upload at the end merges into the same run via `ci_run_id`.

---

## Uploading quality metrics

In addition to the run upload, the CLI and backend support uploading code
coverage, accessibility scans, visual regression diffs, and UI coverage
visits. Each metric is tied to an existing `run_id`, which you can capture
from the response of `POST /runs` or `POST /runs/upload`.

### Code coverage

Point the CLI at an Istanbul `coverage-summary.json` (produced by `nyc`,
`c8`, `jest --coverage`, or Cypress `@cypress/code-coverage`):

```bash
npx flakey-cli coverage --run-id 42 --file coverage/coverage-summary.json
```

The uploader reads the `total` object and stores the lines/branches/
functions/statements percentages plus covered/total line counts. If the
org has coverage gating enabled (Settings → Integrations), the backend
will post a pass/fail commit status to the PR via the configured git
provider.

### Accessibility (axe-core)

Dump axe-core results to JSON from any Cypress, Playwright, or Selenium
test and upload them against the run:

```bash
npx flakey-cli a11y --run-id 42 --file axe-results.json --url /
```

Expected JSON shape is the native axe-core output:

```json
{
  "url": "/",
  "violations": [
    { "id": "label", "impact": "critical", "description": "...", "helpUrl": "..." }
  ],
  "passes":    [ /* ... */ ],
  "incomplete":[ /* ... */ ]
}
```

The backend computes a score automatically using a weighted impact
penalty: `100 − (critical×15 + serious×8 + moderate×4 + minor×1)`.

### Visual regression

Point the CLI at a manifest file that lists each screenshot comparison:

```bash
npx flakey-cli visual --run-id 42 --file visual-manifest.json
```

Manifest format (either a raw array or a `{diffs: [...]}` wrapper):

```json
{
  "diffs": [
    {
      "name": "header-banner",
      "status": "changed",
      "diff_pct": 0.84,
      "baseline_path": "runs/42/visual/header-banner.baseline.png",
      "current_path":  "runs/42/visual/header-banner.current.png",
      "diff_path":     "runs/42/visual/header-banner.diff.png"
    },
    { "name": "footer-links", "status": "unchanged", "diff_pct": 0 }
  ]
}
```

Valid statuses: `pending`, `changed`, `new`, `unchanged`, `approved`,
`rejected`. Image paths should be relative to the artifact storage
root (same conventions as screenshots in the main upload). Reviewers can
approve or reject changed diffs inline from the run detail page.

### UI coverage

Track which routes your tests actually visit. The CLI accepts either a
simple list of strings or an array of `{route_pattern}` objects:

```bash
npx flakey-cli ui-coverage --suite my-e2e --file visits.json --run-id 42
```

```json
["/login", "/dashboard", "/runs", "/settings"]
```

To see untested pages, populate the "known routes" inventory once via the
API (typically from a CI job that scans your SvelteKit / Next.js / Rails
route tree):

```bash
curl -X POST http://localhost:3000/ui-coverage/routes \
  -H "Authorization: Bearer $FLAKEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"routes": ["/","/login","/dashboard","/admin/users","/admin/audit-log"]}'
```

Then `GET /ui-coverage/summary` returns the overall coverage percentage and
`GET /ui-coverage/untested` lists routes that exist in the inventory but
have never been visited by a test.

---

## Auto-Cancellation

CI workers can check the failure count mid-run and exit early:

```bash
RESULT=$(curl -s "$FLAKEY_URL/runs/check?ci_run_id=$GITHUB_RUN_ID&suite=my-suite&threshold=5" \
  -H "Authorization: Bearer $FLAKEY_KEY")
if [ "$(echo $RESULT | jq .should_cancel)" = "true" ]; then
  echo "Failure threshold reached, cancelling"
  exit 1
fi
```
