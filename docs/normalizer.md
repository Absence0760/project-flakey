# Normalizer

## Purpose

Each test reporter outputs a different format. The normalizer converts any supported format into a single unified internal schema so the rest of the app doesn't care which reporter was used.

## Unified schema

```typescript
interface NormalizedRun {
  meta: {
    suite_name: string
    branch: string
    commit_sha: string
    ci_run_id: string
    started_at: string       // ISO 8601
    finished_at: string      // ISO 8601
    reporter: string         // "mochawesome" | "junit" | ...
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
}
```

## Parsers

### mochawesome parser

Mochawesome outputs a custom JSON schema based on Mocha's internal structure.

Key fields to extract:
- `stats.start` / `stats.end` → `started_at` / `finished_at`
- `stats.passes` / `stats.failures` / `stats.pending` / `stats.skipped`
- `stats.duration` → `duration_ms`
- `results[]` → array of spec files
- `results[].suites[].tests[]` → individual test results
- `results[].suites[].tests[].pass` / `.fail` / `.pending` → status
- `results[].suites[].tests[].duration` → test duration
- `results[].suites[].tests[].err.message` → error message

Mochawesome merges multiple spec files into a single JSON when using `mochawesome-merge`. Handle both single-file and merged formats.

### JUnit XML parser

JUnit outputs XML, not JSON. Use a library like `fast-xml-parser` or `xml2js` to convert before normalizing.

Key fields:
- `<testsuites>` root element → run-level stats
- `<testsuite name="..." tests="..." failures="..." time="...">` → spec-level
- `<testcase name="..." classname="..." time="...">` → individual test
- `<failure message="...">` child element → test failed with this message
- `<skipped />` child element → test was skipped
- No child element → test passed

Time values in JUnit are in seconds — multiply by 1000 for `duration_ms`.

## Adding a new reporter

1. Create `/src/normalizer/parsers/{reporter-name}.ts`
2. Export a `parse(raw: unknown): NormalizedRun` function
3. Register it in `/src/normalizer/index.ts` under the reporter key
4. Add the reporter name to the `reporter` union type
5. Write a unit test with a sample output file from that reporter

## Reporter detection

The CLI uploader should detect the format automatically based on file extension and content:

- `.json` with a `stats.passes` key → mochawesome
- `.xml` with a `<testsuites>` root → JUnit
- Fall back to explicit `--reporter` flag if detection fails
