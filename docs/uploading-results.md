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
| `--screenshots-dir` | `cypress/screenshots` | Directory to search for `.png` files |
| `--videos-dir` | `cypress/videos` | Directory to search for `.mp4` files |
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

## How screenshots are matched to tests

Flakey automatically matches screenshots to the correct failed test using filename matching. Here's how it works:

### Cypress screenshot naming convention

When a Cypress test fails, it saves a screenshot with a filename like:

```
Suite Name -- Nested Describe -- test title (failed).png
```

For example:
```
Collections Permissions -- READ X, WRITE ✓ -- Create collection (failed).png
```

### Matching algorithm

During upload, Flakey normalizes both the screenshot filename and each test's `full_title` by stripping everything except lowercase letters and numbers:

```
Filename: "Collections Permissions -- Create collection (failed).png"
  → normalized: "collectionspermissionscreatecollectionfailed"

Test full_title: "Collections Permissions > Create collection"
  → normalized: "collectionspermissionscreatecollection"
```

The matching logic (in order of priority):

1. **Full title match (preferred)** — if the normalized `full_title` is a substring of the normalized filename, the screenshot is assigned. This is the most reliable match because it includes the suite path.
2. **Short title fallback (disabled for short names)** — if the `full_title` doesn't match, the bare `title` is checked, but only if the normalized title is at least 15 characters. This prevents false positives like "Login" matching "Login with SSO (failed).png".

### Videos

Videos are assigned to **all tests in the same run** — not per-test. Cypress records one video per spec file, so all tests in that spec share the same video. When you click any test (passed or failed), the video tab shows the full spec recording.

### What this means in practice

- Screenshots are matched automatically — no configuration needed
- Each test can have multiple screenshots (e.g., `(failed).png` and `(failed) (1).png`)
- If no match is found, screenshots from the reporter's `screenshot_paths` field are used as fallback
- Files are stored per-run in `uploads/runs/{runId}/screenshots/` and `uploads/runs/{runId}/videos/` — no cross-run confusion even with identical test names
- Cypress only captures screenshots on failure by default, so passing tests typically only have the Video tab in the viewer

### Viewing artifacts in the UI

Any test with a video, screenshot, or error message is clickable in the run detail view. Clicking opens a detail modal with:

- **Screenshot tab** — shows when the test has screenshots (typically failed tests). Click to view in a zoomable lightbox.
- **Video tab** — shows when the test has a video. Plays the full spec recording.
- **Error tab** — shows the error message and expandable stack trace.
- **Commands tab** — shows the Cypress command log (if captured).
- **Source tab** — shows the test source code (if captured).

The modal auto-selects the most relevant tab: screenshots if available, then video, then error.

### Edge cases

- If two tests have very similar titles, the `full_title` match (which includes the suite path) almost always distinguishes them
- Short titles under 15 characters (like "Login") won't false-match via substring
- Special characters (unicode, checkmarks, emoji) are stripped during normalization, so they don't affect matching
- Filenames with mangled encoding (common with unicode in filenames) are handled because normalization strips non-alphanumeric characters

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
