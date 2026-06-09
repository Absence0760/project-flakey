import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Resolve the CLI entry from this test file, regardless of the test
// runner's CWD. We invoke through `tsx` so we don't require `pnpm build`
// to have run first.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, "..", "index.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env: { ...process.env, ...env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("resolveOptions: suiteName falls back to FLAKEY_SUITE env when --suite is absent", async () => {
  // FLAKEY_SUITE is the canonical env-var name across every reporter
  // adapter. Without this fallback, a CI invocation that exports
  // FLAKEY_SUITE but omits --suite silently filed runs under "default".
  process.env.FLAKEY_SUITE = "ci-env-suite";
  try {
    const { resolveOptions } = await import("../index.ts");
    const opts = resolveOptions({});
    assert.equal(opts.suiteName, "ci-env-suite");
  } finally {
    delete process.env.FLAKEY_SUITE;
  }
});

test("resolveOptions: --suite wins over FLAKEY_SUITE env var", async () => {
  process.env.FLAKEY_SUITE = "ci-env-suite";
  try {
    const { resolveOptions } = await import("../index.ts");
    const opts = resolveOptions({ suite: "explicit-suite" });
    assert.equal(opts.suiteName, "explicit-suite");
  } finally {
    delete process.env.FLAKEY_SUITE;
  }
});

test("resolveOptions: with no --suite and no FLAKEY_SUITE, falls back to literal 'default'", async () => {
  delete process.env.FLAKEY_SUITE;
  const { resolveOptions } = await import("../index.ts");
  const opts = resolveOptions({});
  assert.equal(opts.suiteName, "default");
});

test("`flakey-cli <unknown-subcommand>` prints help and exits non-zero", async () => {
  const { code, stderr } = await runCli(["does-not-exist"]);
  assert.notEqual(code, 0, "unknown subcommand must exit with non-zero status");
  assert.match(
    stderr,
    /Unknown subcommand|Available:/,
    "should mention the subcommand routing in its error output",
  );
});

test("`flakey-cli coverage` without --run-id prints a usage line and exits non-zero", async () => {
  const { code, stderr } = await runCli(["coverage"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli coverage/);
});

test("`flakey-cli a11y` without args prints a11y usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["a11y"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli a11y/);
});

test("`flakey-cli visual` without args prints visual usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["visual"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli visual/);
});

test("`flakey-cli ui-coverage` without --suite prints usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["ui-coverage"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli ui-coverage/);
});

test("`flakey-cli upload --report-dir <missing>` exits with a 'no report files' error", async () => {
  const { code, stderr } = await runCli(
    [
      "upload",
      "--report-dir",
      "/tmp/definitely-not-a-real-dir-xyz",
      "--suite",
      "unit-test",
      "--reporter",
      "mochawesome",
    ],
    { FLAKEY_API_KEY: "dummy" },
  );
  assert.notEqual(code, 0, "missing report dir → non-zero exit");
  assert.match(
    stderr,
    /No report files found/,
    "should explain that the reporter dir is empty / missing",
  );
});

// ─── parseFlags ───────────────────────────────────────────────────────────

test("parseFlags: parses --flag value pairs", async () => {
  const { parseFlags } = await import("../index.ts");
  assert.deepEqual(
    parseFlags(["--report-dir", "cypress/reports", "--suite", "checkout"]),
    { "report-dir": "cypress/reports", suite: "checkout" },
  );
});

test("parseFlags: a flag with an omitted value does not swallow the next flag", async () => {
  // Regression: `--report-dir --suite x` must NOT set report-dir="--suite"
  // and drop --suite. The flag with no value becomes "", and the following
  // flag is parsed normally.
  const { parseFlags } = await import("../index.ts");
  assert.deepEqual(
    parseFlags(["--report-dir", "--suite", "checkout"]),
    { "report-dir": "", suite: "checkout" },
  );
});

test("parseFlags: a trailing flag with no value becomes an empty string", async () => {
  const { parseFlags } = await import("../index.ts");
  assert.deepEqual(parseFlags(["--suite"]), { suite: "" });
});

test("parseFlags: ignores leading positional tokens that are not flags", async () => {
  const { parseFlags } = await import("../index.ts");
  // Bare tokens before the first flag (e.g. a stray arg) are skipped.
  assert.deepEqual(parseFlags(["junk", "--suite", "x"]), { suite: "x" });
});

test("`flakey-cli a11y` with an empty-array results file exits cleanly, not with a crash", async () => {
  // Regression: an axe run that produced `[]` must not throw a TypeError on
  // `result.url`; it should report "no results" and exit non-zero.
  const dir = makeTmpDir();
  try {
    const file = join(dir, "axe.json");
    writeFileSync(file, "[]");
    const { code, stderr } = await runCli(
      ["a11y", "--run-id", "42", "--file", file],
      { FLAKEY_API_KEY: "dummy" },
    );
    assert.notEqual(code, 0, "empty axe results → non-zero exit");
    assert.match(stderr, /No axe-core results found/);
    assert.doesNotMatch(stderr, /TypeError|Cannot read prop/i, "must not crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`flakey-cli upload --reporter <bogus>` rejects the unknown reporter instead of falling through to mochawesome", async () => {
  // Regression: an unknown reporter used to silently use the mochawesome path
  // and grab any .json in the report dir.
  const dir = makeTmpDir();
  try {
    // A real .json is present — the old behavior would have parsed it.
    writeFileSync(join(dir, "results.json"), "{}");
    const { code, stderr } = await runCli(
      ["upload", "--reporter", "totally-bogus", "--report-dir", dir],
      { FLAKEY_API_KEY: "dummy" },
    );
    assert.notEqual(code, 0, "unknown reporter → non-zero exit");
    assert.match(stderr, /Unknown reporter "totally-bogus"/);
    assert.match(stderr, /mochawesome, junit, playwright/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── resolveOptions: CI metadata fallback chains ──────────────────────────
// A CI invocation that omits the explicit flags must still derive
// branch/commit/run-id from the provider's default env vars, in the exact
// documented precedence (see flakey-cli/CLAUDE.md). These chains are the
// kind of thing that silently regresses, so pin every rung.

// resolveOptions reads several module-level / process.env vars when called.
// Each test sets only the env it asserts on and clears it in `finally`, so
// the chain precedence is exercised without cross-test bleed.
const CI_ENV_VARS = [
  "BRANCH",
  "GITHUB_HEAD_REF",
  "GITHUB_REF_NAME",
  "BITBUCKET_BRANCH",
  "COMMIT_SHA",
  "GITHUB_SHA",
  "BITBUCKET_COMMIT",
  "CI_RUN_ID",
  "GITHUB_RUN_ID",
  "BITBUCKET_BUILD_NUMBER",
];

function clearCiEnv() {
  for (const v of CI_ENV_VARS) delete process.env[v];
}

test("resolveOptions: branch precedence --branch > BRANCH > GITHUB_HEAD_REF > GITHUB_REF_NAME > BITBUCKET_BRANCH", async () => {
  const { resolveOptions } = await import("../index.ts");
  clearCiEnv();
  try {
    // All env set + explicit flag → flag wins.
    process.env.BRANCH = "env-branch";
    process.env.GITHUB_HEAD_REF = "gh-head";
    process.env.GITHUB_REF_NAME = "gh-ref";
    process.env.BITBUCKET_BRANCH = "bb-branch";
    assert.equal(resolveOptions({ branch: "flag-branch" }).branch, "flag-branch");

    // No flag, BRANCH set → BRANCH wins over all the GH/BB vars.
    assert.equal(resolveOptions({}).branch, "env-branch");

    // Drop BRANCH → GITHUB_HEAD_REF (PR source branch) wins next.
    delete process.env.BRANCH;
    assert.equal(resolveOptions({}).branch, "gh-head");

    // Drop GITHUB_HEAD_REF → GITHUB_REF_NAME.
    delete process.env.GITHUB_HEAD_REF;
    assert.equal(resolveOptions({}).branch, "gh-ref");

    // Drop GITHUB_REF_NAME → BITBUCKET_BRANCH.
    delete process.env.GITHUB_REF_NAME;
    assert.equal(resolveOptions({}).branch, "bb-branch");

    // Drop everything → empty string (not "default").
    delete process.env.BITBUCKET_BRANCH;
    assert.equal(resolveOptions({}).branch, "");
  } finally {
    clearCiEnv();
  }
});

test("resolveOptions: commit precedence --commit > COMMIT_SHA > GITHUB_SHA > BITBUCKET_COMMIT", async () => {
  const { resolveOptions } = await import("../index.ts");
  clearCiEnv();
  try {
    process.env.COMMIT_SHA = "env-sha";
    process.env.GITHUB_SHA = "gh-sha";
    process.env.BITBUCKET_COMMIT = "bb-sha";
    assert.equal(resolveOptions({ commit: "flag-sha" }).commitSha, "flag-sha");

    assert.equal(resolveOptions({}).commitSha, "env-sha");

    delete process.env.COMMIT_SHA;
    assert.equal(resolveOptions({}).commitSha, "gh-sha");

    delete process.env.GITHUB_SHA;
    assert.equal(resolveOptions({}).commitSha, "bb-sha");

    delete process.env.BITBUCKET_COMMIT;
    assert.equal(resolveOptions({}).commitSha, "");
  } finally {
    clearCiEnv();
  }
});

test("resolveOptions: ciRunId precedence --ci-run-id > CI_RUN_ID > GITHUB_RUN_ID > BITBUCKET_BUILD_NUMBER", async () => {
  const { resolveOptions } = await import("../index.ts");
  clearCiEnv();
  try {
    process.env.CI_RUN_ID = "env-run";
    process.env.GITHUB_RUN_ID = "gh-run";
    process.env.BITBUCKET_BUILD_NUMBER = "bb-run";
    assert.equal(resolveOptions({ "ci-run-id": "flag-run" }).ciRunId, "flag-run");

    assert.equal(resolveOptions({}).ciRunId, "env-run");

    delete process.env.CI_RUN_ID;
    assert.equal(resolveOptions({}).ciRunId, "gh-run");

    delete process.env.GITHUB_RUN_ID;
    assert.equal(resolveOptions({}).ciRunId, "bb-run");

    delete process.env.BITBUCKET_BUILD_NUMBER;
    assert.equal(resolveOptions({}).ciRunId, "");
  } finally {
    clearCiEnv();
  }
});

test("resolveOptions: reporter defaults to mochawesome and apiKey falls back to --api-key flag", async () => {
  const { resolveOptions } = await import("../index.ts");
  assert.equal(resolveOptions({}).reporter, "mochawesome");
  assert.equal(resolveOptions({ reporter: "junit" }).reporter, "junit");
  assert.equal(resolveOptions({ "api-key": "abc123" }).apiKey, "abc123");
});

// ─── authHeaders ──────────────────────────────────────────────────────────

test("authHeaders: emits a Bearer Authorization header when an apiKey is set", async () => {
  const { authHeaders } = await import("../index.ts");
  assert.deepEqual(authHeaders("secret-key"), { Authorization: "Bearer secret-key" });
});

test("authHeaders: emits no Authorization header when apiKey is blank", async () => {
  const { authHeaders } = await import("../index.ts");
  assert.deepEqual(authHeaders(""), {});
});

// ─── findReportFile ───────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "flakey-cli-test-"));
}

test("findReportFile: returns null when the report dir does not exist", async () => {
  const { findReportFile } = await import("../index.ts");
  assert.equal(findReportFile("/tmp/no-such-flakey-dir-xyz-123", "mochawesome"), null);
});

test("findReportFile: mochawesome prefers mochawesome.json over other JSON", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "zzz-other.json"), "{}");
    writeFileSync(join(dir, "mochawesome.json"), "{}");
    const result = findReportFile(dir, "mochawesome");
    assert.deepEqual(result, { path: join(dir, "mochawesome.json"), isXml: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: mochawesome falls back to any .json when mochawesome.json is absent", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "report.json"), "{}");
    const result = findReportFile(dir, "mochawesome");
    assert.deepEqual(result, { path: join(dir, "report.json"), isXml: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: mochawesome returns null when no JSON present", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "notes.txt"), "hi");
    assert.equal(findReportFile(dir, "mochawesome"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: playwright prefers results.json over other JSON", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "aaa-other.json"), "{}");
    writeFileSync(join(dir, "results.json"), "{}");
    const result = findReportFile(dir, "playwright");
    assert.deepEqual(result, { path: join(dir, "results.json"), isXml: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: playwright falls back to any .json when results.json absent", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "pw-report.json"), "{}");
    const result = findReportFile(dir, "playwright");
    assert.deepEqual(result, { path: join(dir, "pw-report.json"), isXml: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: junit picks an .xml file and flags isXml", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    // A .json present must NOT be chosen for the junit reporter.
    writeFileSync(join(dir, "ignored.json"), "{}");
    writeFileSync(join(dir, "junit.xml"), "<testsuites/>");
    const result = findReportFile(dir, "junit");
    assert.deepEqual(result, { path: join(dir, "junit.xml"), isXml: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findReportFile: junit returns null when no .xml present", async () => {
  const { findReportFile } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "results.json"), "{}");
    assert.equal(findReportFile(dir, "junit"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── findFiles ────────────────────────────────────────────────────────────

test("findFiles: returns [] when the dir is missing", async () => {
  const { findFiles } = await import("../index.ts");
  assert.deepEqual(findFiles("/tmp/no-such-flakey-dir-xyz-456", ".png"), []);
});

test("findFiles: recurses, filters by extension, and returns absolute paths", async () => {
  const { findFiles } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "top.png"), "x");
    writeFileSync(join(dir, "skip.txt"), "x");
    writeFileSync(join(nested, "deep.png"), "x");
    writeFileSync(join(nested, "movie.mp4"), "x");

    const pngs = findFiles(dir, ".png");
    assert.equal(pngs.length, 2);
    // Absolute paths only.
    for (const p of pngs) assert.equal(p, resolve(p));
    const sorted = [...pngs].sort();
    assert.deepEqual(sorted, [join(nested, "deep.png"), join(dir, "top.png")].sort());

    // Extension filter is exact: .mp4 query finds only the video.
    assert.deepEqual(findFiles(dir, ".mp4"), [join(nested, "movie.mp4")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── extractPlaywrightAttachments ─────────────────────────────────────────

test("extractPlaywrightAttachments: classifies image/video, resolves relative paths, dedups, skips missing/no-path", async () => {
  const { extractPlaywrightAttachments } = await import("../index.ts");
  const dir = makeTmpDir();
  try {
    // Real on-disk artifacts the report points at.
    writeFileSync(join(dir, "shot.png"), "img");
    writeFileSync(join(dir, "clip.webm"), "vid");
    const absShot = join(dir, "abs-shot.png");
    writeFileSync(absShot, "img");

    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  results: [
                    {
                      attachments: [
                        // relative path → resolved against reportDir
                        { contentType: "image/png", path: "shot.png" },
                        // duplicate of the same file → deduped
                        { contentType: "image/png", path: "shot.png" },
                        // absolute path passed through as-is
                        { contentType: "image/png", path: absShot },
                        // video classification
                        { contentType: "video/webm", path: "clip.webm" },
                        // missing file on disk → skipped
                        { contentType: "image/png", path: "ghost.png" },
                        // no path → skipped
                        { contentType: "image/png" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          // Nested suite to exercise the recursive walk.
          suites: [
            {
              specs: [
                {
                  tests: [
                    {
                      results: [
                        { attachments: [{ contentType: "image/jpeg", path: "shot.png" }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { screenshots, videos } = extractPlaywrightAttachments(report, dir);

    // shot.png (relative) + abs-shot.png; the duplicate shot.png and the
    // nested-suite shot.png both dedup to the same absolute path.
    assert.deepEqual([...screenshots].sort(), [join(dir, "shot.png"), absShot].sort());
    assert.deepEqual(videos, [join(dir, "clip.webm")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractPlaywrightAttachments: empty report yields empty arrays", async () => {
  const { extractPlaywrightAttachments } = await import("../index.ts");
  const { screenshots, videos } = extractPlaywrightAttachments({}, "/tmp");
  assert.deepEqual(screenshots, []);
  assert.deepEqual(videos, []);
});

// ─── normalizeIstanbulSummary ─────────────────────────────────────────────

test("normalizeIstanbulSummary: reads from report.total and extracts pct + covered/total", async () => {
  const { normalizeIstanbulSummary } = await import("../index.ts");
  const report = {
    total: {
      lines: { pct: 91.5, covered: 183, total: 200 },
      branches: { pct: 80 },
      functions: { pct: 75 },
      statements: { pct: 88 },
    },
  };
  assert.deepEqual(normalizeIstanbulSummary(report), {
    lines_pct: 91.5,
    branches_pct: 80,
    functions_pct: 75,
    statements_pct: 88,
    lines_covered: 183,
    lines_total: 200,
  });
});

test("normalizeIstanbulSummary: falls back to the flat report when report.total is absent", async () => {
  const { normalizeIstanbulSummary } = await import("../index.ts");
  // No `total` key → the report object itself is treated as the summary.
  const flat = {
    lines: { pct: 50, covered: 5, total: 10 },
    branches: { pct: 40 },
    functions: { pct: 30 },
    statements: { pct: 20 },
  };
  assert.deepEqual(normalizeIstanbulSummary(flat), {
    lines_pct: 50,
    branches_pct: 40,
    functions_pct: 30,
    statements_pct: 20,
    lines_covered: 5,
    lines_total: 10,
  });
});

test("normalizeIstanbulSummary: missing metrics coerce to 0 and string pcts coerce to Number", async () => {
  const { normalizeIstanbulSummary } = await import("../index.ts");
  const report = { total: { lines: { pct: "73.2" } } };
  const out = normalizeIstanbulSummary(report);
  assert.equal(out.lines_pct, 73.2);
  assert.equal(typeof out.lines_pct, "number");
  assert.equal(out.branches_pct, 0);
  assert.equal(out.functions_pct, 0);
  assert.equal(out.statements_pct, 0);
  assert.equal(out.lines_covered, 0);
  assert.equal(out.lines_total, 0);
});
