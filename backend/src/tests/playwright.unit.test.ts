/**
 * Playwright parser unit tests.
 *
 * Coverage for parsePlaywright() — the second-most-used reporter format
 * after Cypress/mochawesome.  Targets:
 *   - Empty / null payloads (defensive parsing of partial uploads)
 *   - Status mapping (timedOut → failed, interrupted → failed, etc.)
 *   - Retries (results[] array, last result wins)
 *   - Tags merged from spec + test
 *   - Screenshots/videos via attachments
 *   - finished_at computation when stats.duration is missing/NaN
 *     (regression: `new Date(NaN).toISOString()` throws RangeError,
 *      crashing the entire upload pipeline)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywright } from "../normalizers/playwright.js";
import type { NormalizedRun } from "../types.js";

const META: NormalizedRun["meta"] = {
  suite_name: "smoke",
  branch: "main",
  commit_sha: "abc",
  ci_run_id: "",
  reporter: "playwright",
  started_at: "",
  finished_at: "",
  environment: "",
};

// ── Empty / null ─────────────────────────────────────────────────────────

test("parsePlaywright: empty object produces a valid run with zero stats", () => {
  const out = parsePlaywright({} as any, META);
  assert.equal(out.specs.length, 0);
  assert.equal(out.stats.total, 0);
  // finished_at must be a valid ISO string — Postgres timestamps reject
  // anything else.
  assert.doesNotThrow(() => new Date(out.meta.finished_at).toISOString());
});

test("parsePlaywright: missing stats but present suites still produces a finite finished_at", () => {
  // Real-world failure: when raw.stats.duration is undefined and
  // tests have undefined duration → run.stats.duration_ms is the sum
  // of undefineds = NaN → `new Date(start + NaN).toISOString()` throws
  // RangeError, killing the import endpoint with a 500.  Defense: clamp.
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t1",
        ok: true,
        tests: [{
          title: "t1",
          ok: true,
          results: [{ status: "passed", duration: undefined as any }],
        }],
      }],
    }],
  } as any, META);
  assert.doesNotThrow(
    () => new Date(out.meta.finished_at).toISOString(),
    "finished_at must be a representable ISO string"
  );
});

// ── Status mapping ───────────────────────────────────────────────────────

test("parsePlaywright: timedOut and interrupted both map to failed", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [
        { title: "a", ok: false, tests: [{ title: "a", ok: false, results: [{ status: "timedOut", duration: 5000 }] }] },
        { title: "b", ok: false, tests: [{ title: "b", ok: false, results: [{ status: "interrupted", duration: 100 }] }] },
        { title: "c", ok: true,  tests: [{ title: "c", ok: true,  results: [{ status: "passed",      duration: 10 }] }] },
        { title: "d", ok: true,  tests: [{ title: "d", ok: true,  results: [{ status: "skipped",     duration: 0 }] }] },
      ],
    }],
  } as any, META);
  assert.equal(out.stats.failed, 2, "timedOut + interrupted should count as failed");
  assert.equal(out.stats.passed, 1);
  assert.equal(out.stats.skipped, 1);
});

// ── Retries ──────────────────────────────────────────────────────────────

test("parsePlaywright: only the LAST result determines test status (final attempt)", () => {
  // A flaky test that fails twice then passes should appear as passed.
  // Aggregate counts must reflect the final attempt, not all attempts —
  // otherwise the run looks worse than it is.
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "flaky",
        ok: true,
        tests: [{
          title: "flaky",
          ok: true,
          results: [
            { status: "failed", duration: 100, error: { message: "first attempt" } },
            { status: "failed", duration: 100, error: { message: "second attempt" } },
            { status: "passed", duration: 50 },
          ],
        }],
      }],
    }],
  } as any, META);
  assert.equal(out.stats.passed, 1, "flaky-passing test should count as passed");
  assert.equal(out.stats.failed, 0);
});

test("parsePlaywright: retries are surfaced in metadata when a test had multiple attempts", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "flaky",
        ok: true,
        tests: [{
          title: "flaky",
          ok: true,
          results: [
            { status: "failed", duration: 100, error: { message: "boom" } },
            { status: "passed", duration: 50 },
          ],
        }],
      }],
    }],
  } as any, META);
  const meta = (out.specs[0].tests[0] as any).metadata;
  assert.ok(meta?.retries, "retries metadata should be populated");
  assert.equal(meta.retries.length, 2);
  assert.equal(meta.retries[0].status, "failed");
  assert.equal(meta.retries[1].status, "passed");
});

// ── Tags ─────────────────────────────────────────────────────────────────

test("parsePlaywright: tags from spec and test are merged and deduped", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t",
        ok: true,
        tags: ["@smoke", "@auth"],
        tests: [{
          title: "t",
          ok: true,
          tags: ["@smoke", "@regression"],
          results: [{ status: "passed", duration: 10 }],
        }],
      }],
    }],
  } as any, META);
  const meta = (out.specs[0].tests[0] as any).metadata;
  assert.ok(meta?.tags);
  const tags = meta.tags.sort();
  assert.deepEqual(tags, ["@auth", "@regression", "@smoke"]);
});

// ── Attachments ──────────────────────────────────────────────────────────

test("parsePlaywright: image attachments become screenshot_paths", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t", ok: false,
        tests: [{ title: "t", ok: false, results: [{
          status: "failed", duration: 100,
          attachments: [
            { name: "screenshot", contentType: "image/png", path: "/snap1.png" },
            { name: "screenshot", contentType: "image/png", path: "/snap2.png" },
            { name: "trace", contentType: "application/zip", path: "/trace.zip" },
          ],
        }] }],
      }],
    }],
  } as any, META);
  const t = out.specs[0].tests[0];
  assert.deepEqual(t.screenshot_paths.sort(), ["/snap1.png", "/snap2.png"]);
});

test("parsePlaywright: video attachment becomes video_path", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t", ok: true,
        tests: [{ title: "t", ok: true, results: [{
          status: "passed", duration: 100,
          attachments: [{ name: "video", contentType: "video/webm", path: "/vid.webm" }],
        }] }],
      }],
    }],
  } as any, META);
  assert.equal(out.specs[0].tests[0].video_path, "/vid.webm");
});

// ── Nested suites ────────────────────────────────────────────────────────

test("parsePlaywright: nested suites flatten into the same spec keyed by file", () => {
  const out = parsePlaywright({
    suites: [{
      title: "Outer",
      file: "shared.spec.ts",
      suites: [{
        title: "Inner",
        file: "shared.spec.ts",
        specs: [
          { title: "a", ok: true, tests: [{ title: "a", ok: true, results: [{ status: "passed", duration: 1 }] }] },
        ],
      }],
      specs: [
        { title: "b", ok: true, tests: [{ title: "b", ok: true, results: [{ status: "passed", duration: 1 }] }] },
      ],
    }],
  } as any, META);
  // Both `a` and `b` live in shared.spec.ts and should produce one spec.
  assert.equal(out.specs.length, 1);
  assert.equal(out.specs[0].tests.length, 2);
});

// ── Errors ───────────────────────────────────────────────────────────────

test("parsePlaywright: error.message and error.stack are captured", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t", ok: false,
        tests: [{
          title: "t", ok: false,
          results: [{
            status: "failed", duration: 1,
            error: { message: "expect(...) failed", stack: "at line 5" },
          }],
        }],
      }],
    }],
  } as any, META);
  const t = out.specs[0].tests[0];
  assert.ok(t.error?.message?.includes("expect"));
  assert.ok(t.error?.stack?.includes("line 5"));
});

test("parsePlaywright: error array (errors[]) falls through when error is missing", () => {
  const out = parsePlaywright({
    suites: [{
      title: "S",
      file: "s.spec.ts",
      specs: [{
        title: "t", ok: false,
        tests: [{
          title: "t", ok: false,
          results: [{
            status: "failed", duration: 1,
            errors: [{ message: "first" }, { message: "second" }],
          }],
        }],
      }],
    }],
  } as any, META);
  // First error wins (per extractError implementation)
  assert.ok(out.specs[0].tests[0].error?.message?.includes("first"));
});

// ── Stress ───────────────────────────────────────────────────────────────

test("parsePlaywright: 500-test report parses well under 1s", () => {
  const specs = Array.from({ length: 500 }, (_, i) => ({
    title: `t${i}`, ok: true,
    tests: [{ title: `t${i}`, ok: true, results: [{ status: "passed", duration: 1 }] }],
  }));
  const start = Date.now();
  const out = parsePlaywright({
    suites: [{ title: "S", file: "s.spec.ts", specs }],
  } as any, META);
  const dur = Date.now() - start;
  assert.equal(out.stats.total, 500);
  assert.ok(dur < 1000, `500-test parse took ${dur}ms`);
});
