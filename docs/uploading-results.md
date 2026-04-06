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
2. Click **Profile** at the bottom of the sidebar
3. Under **API Keys**, enter a label and click **Create key**
4. Copy the key (starts with `fk_`) — it's only shown once

---

## Method 1: CLI Uploader (recommended)

The CLI finds report files, discovers screenshots and videos, matches them to tests, and uploads everything in one multipart request.

### Cypress + Mochawesome

```bash
# From your Cypress project root:
npx tsx /path/to/flakey/cli/src/index.ts \
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
npx tsx /path/to/flakey/cli/src/index.ts \
  --report-dir cypress/reports \
  --suite my-project \
  --api-key fk_your_key_here
```

### Playwright

```bash
npx tsx /path/to/flakey/cli/src/index.ts \
  --report-dir playwright-report \
  --suite my-playwright-tests \
  --reporter playwright \
  --api-key fk_your_key_here
```

For Playwright, you **don't need** `--screenshots-dir` or `--videos-dir`. The CLI reads the JSON report and automatically extracts all screenshot and video file paths from the `attachments` field in each test result. It resolves both absolute and relative paths, then uploads the files alongside the report.

Playwright records videos as `.webm` by default — this format is fully supported.

### JUnit XML (Jest, pytest, Go, etc.)

```bash
npx tsx /path/to/flakey/cli/src/index.ts \
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

npx tsx /path/to/flakey/cli/src/index.ts \
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

## Generating reports

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
    npx tsx /path/to/flakey/cli/src/index.ts \
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
      - npx tsx /path/to/flakey/cli/src/index.ts
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
    - npx tsx /path/to/flakey/cli/src/index.ts
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
