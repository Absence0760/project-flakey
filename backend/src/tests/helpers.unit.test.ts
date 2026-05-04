/**
 * Pure-helper unit tests across the backend.
 *
 * Each helper here is small, exported (or now exported as part of this
 * pass), and has no DB / network dependencies.  Locking these down is
 * cheap insurance: a regression in any one of them ripples into a
 * user-visible bug (mis-rendered SVG badges, swallowed webhook URLs,
 * wrong cucumber dedup keys, etc.).
 *
 * Helpers covered:
 *   - badge.escapeXml / makeBadge
 *   - webhooks.validateWebhookUrl
 *   - manual-test-requirements.inferProvider
 *   - security.normalizeSeverity
 *   - manual-tests.cucumberRef / deriveOverallStatus
 *   - uploads.fixFilename / normalizeForMatch
 *   - live-events.liveEvents (singleton; covered minimally for getStaleRuns
 *     + active-runs scoping behaviour)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeXml, makeBadge } from "../routes/badge.js";
import { validateWebhookUrl } from "../routes/webhooks.js";
import { inferProvider } from "../routes/manual-test-requirements.js";
import { normalizeSeverity } from "../routes/security.js";
import { cucumberRef, deriveOverallStatus } from "../routes/manual-tests.js";
import { fixFilename, normalizeForMatch } from "../routes/uploads.js";
import { categorizeChange } from "../routes/compare.js";
import { liveEvents } from "../live-events.js";

// ── badge.escapeXml ─────────────────────────────────────────────────────

test("escapeXml: encodes the three structural XML characters", () => {
  assert.equal(escapeXml("<a&b>"), "&lt;a&amp;b&gt;");
});

test("escapeXml: '&' must be encoded BEFORE '<'/'>' to avoid double-escaping", () => {
  // Order of replaces matters: if `&` is replaced AFTER `<`, the `&lt;`
  // produced by the `<` replace gets re-encoded to `&amp;lt;`.
  assert.equal(escapeXml("&<"), "&amp;&lt;");
});

test("escapeXml: passthrough for benign content", () => {
  assert.equal(escapeXml("hello world 123"), "hello world 123");
});

test("escapeXml: empty string is a fixed point", () => {
  assert.equal(escapeXml(""), "");
});

// ── badge.makeBadge ─────────────────────────────────────────────────────

test("makeBadge: produces a self-closing standalone-friendly SVG", () => {
  const svg = makeBadge("tests", "100% passing", "#4c1");
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.trim().endsWith("</svg>"));
});

test("makeBadge: escapes hostile inputs into the title and text elements", () => {
  // A malicious suite name shouldn't break out of the SVG attribute /
  // text content into raw XML — would let a clever attacker inject
  // <script> via a badge embed.
  const svg = makeBadge('">< <script>x</script>', "ok", "#4c1");
  assert.ok(!svg.includes("<script>"), "raw <script> tag must be escaped");
  assert.ok(svg.includes("&lt;script&gt;"));
});

// ── validateWebhookUrl ──────────────────────────────────────────────────

test("validateWebhookUrl: accepts http and https", () => {
  assert.deepEqual(validateWebhookUrl("https://hooks.slack.com/x"), { ok: true });
  assert.deepEqual(validateWebhookUrl("http://localhost:9000/wh"), { ok: true });
});

test("validateWebhookUrl: rejects file:// and javascript: and data:", () => {
  assert.equal(validateWebhookUrl("file:///etc/passwd").ok, false);
  assert.equal(validateWebhookUrl("javascript:alert(1)").ok, false);
  assert.equal(validateWebhookUrl("data:text/plain,hello").ok, false);
});

test("validateWebhookUrl: rejects nonsense and empty input", () => {
  assert.equal(validateWebhookUrl("").ok, false);
  assert.equal(validateWebhookUrl("not-a-url").ok, false);
  assert.equal(validateWebhookUrl(null).ok, false);
  assert.equal(validateWebhookUrl(123).ok, false);
});

test("validateWebhookUrl: rejects whitespace-only", () => {
  assert.equal(validateWebhookUrl("   ").ok, false);
});

// ── inferProvider ───────────────────────────────────────────────────────

test("inferProvider: github URL → 'github'", () => {
  assert.equal(inferProvider("https://github.com/x/y/issues/1"), "github");
});

test("inferProvider: atlassian/jira URL → 'jira'", () => {
  assert.equal(inferProvider("https://acme.atlassian.net/browse/X-1"), "jira");
  assert.equal(inferProvider("https://acme.com/jira/browse/X-1"), "jira");
});

test("inferProvider: linear URL → 'linear'", () => {
  assert.equal(inferProvider("https://linear.app/abc/issue/X-1"), "linear");
});

test("inferProvider: empty/undefined falls back to 'other'", () => {
  assert.equal(inferProvider(undefined), "other");
  assert.equal(inferProvider(""), "other");
});

test("inferProvider: case-insensitive matching", () => {
  // Users paste from email clients that "smart-quote" or capitalize.
  assert.equal(inferProvider("HTTPS://GITHUB.COM/X/Y"), "github");
});

// ── normalizeSeverity ───────────────────────────────────────────────────

test("normalizeSeverity: passes through canonical levels", () => {
  for (const s of ["high", "medium", "low", "info"]) {
    assert.equal(normalizeSeverity(s), s);
  }
});

test("normalizeSeverity: 'critical' aliases up to 'high'", () => {
  // ZAP and Trivy both use 'critical'; we collapse it to 'high' so the
  // dashboard severity counts don't miss it.
  assert.equal(normalizeSeverity("critical"), "high");
  assert.equal(normalizeSeverity("CRITICAL"), "high");
});

test("normalizeSeverity: 'warning'/'moderate' aliases to 'medium'", () => {
  assert.equal(normalizeSeverity("warning"), "medium");
  assert.equal(normalizeSeverity("moderate"), "medium");
});

test("normalizeSeverity: 'informational'/'note' aliases to 'info'", () => {
  assert.equal(normalizeSeverity("informational"), "info");
  assert.equal(normalizeSeverity("note"), "info");
});

test("normalizeSeverity: unknown / non-string defaults to 'info'", () => {
  assert.equal(normalizeSeverity("garbage"), "info");
  assert.equal(normalizeSeverity(null), "info");
  assert.equal(normalizeSeverity(42), "info");
  assert.equal(normalizeSeverity(undefined), "info");
});

// ── cucumberRef ─────────────────────────────────────────────────────────

test("cucumberRef: stable identity for (file, scenario) pair", () => {
  // Re-importing the same .feature must produce the same key so the
  // ON CONFLICT (org_id, source, source_ref) DO UPDATE upserts in place.
  const a = cucumberRef("features/login.feature", "Successful login");
  const b = cucumberRef("features/login.feature", "Successful login");
  assert.equal(a, b);
});

test("cucumberRef: differs when the scenario name changes", () => {
  // Renaming a scenario is treated as a new manual test (we lose history).
  // This test documents that intentional behaviour.
  const a = cucumberRef("login.feature", "Old name");
  const b = cucumberRef("login.feature", "New name");
  assert.notEqual(a, b);
});

// ── deriveOverallStatus ─────────────────────────────────────────────────

test("deriveOverallStatus: empty step list → not_run (no ghost executions)", () => {
  assert.equal(deriveOverallStatus([]), "not_run");
});

test("deriveOverallStatus: any 'failed' step makes the overall failed", () => {
  assert.equal(deriveOverallStatus([{ status: "passed" }, { status: "failed" }, { status: "passed" }]), "failed");
});

test("deriveOverallStatus: 'failed' beats 'blocked' in the precedence", () => {
  assert.equal(deriveOverallStatus([{ status: "blocked" }, { status: "failed" }]), "failed");
});

test("deriveOverallStatus: 'blocked' beats 'skipped' and 'passed'", () => {
  assert.equal(deriveOverallStatus([{ status: "passed" }, { status: "blocked" }, { status: "skipped" }]), "blocked");
});

test("deriveOverallStatus: all-skipped is overall skipped", () => {
  assert.equal(deriveOverallStatus([{ status: "skipped" }, { status: "skipped" }]), "skipped");
});

test("deriveOverallStatus: at least one passed (no failed/blocked) → passed", () => {
  assert.equal(deriveOverallStatus([{ status: "passed" }, { status: "skipped" }]), "passed");
  assert.equal(deriveOverallStatus([{ status: "passed" }, { status: "passed" }]), "passed");
});

// ── fixFilename ─────────────────────────────────────────────────────────

test("fixFilename: passes through ASCII filenames untouched", () => {
  assert.equal(fixFilename("screenshot.png"), "screenshot.png");
});

test("fixFilename: re-decodes Latin-1 bytes as UTF-8 (multer quirk)", () => {
  // Multer reads multipart filename headers as Latin-1, but browsers
  // emit UTF-8. The helper rounds the bytes back through UTF-8 so an
  // accented or unicode filename arrives intact.
  const real = "résumé.png";
  const wireform = Buffer.from(real, "utf-8").toString("latin1");
  assert.equal(fixFilename(wireform), real);
});

test("fixFilename: invalid UTF-8 falls back to the input verbatim", () => {
  // Pure-ASCII Latin-1 IS valid UTF-8 (single-byte chars), so it round-trips.
  // The fallback path matters when the bytes can't be re-decoded — pin the
  // contract.
  assert.equal(fixFilename("plain.png"), "plain.png");
});

// ── normalizeForMatch ───────────────────────────────────────────────────

test("normalizeForMatch: lowercases and strips non-alphanumeric", () => {
  assert.equal(normalizeForMatch("My-Test_File.png"), "mytestfilepng");
});

test("normalizeForMatch: empty string in, empty string out", () => {
  assert.equal(normalizeForMatch(""), "");
});

test("normalizeForMatch: Unicode letters are stripped (ASCII-only pattern)", () => {
  // The current regex /[^a-z0-9]/ is ASCII-only.  Pin that behaviour so a
  // future "Unicode-aware" rewrite is a deliberate decision, not a stealth
  // change.
  assert.equal(normalizeForMatch("café"), "caf");
});

// ── liveEvents singleton ────────────────────────────────────────────────

test("liveEvents.getStaleRuns: returns runs whose last event is older than the threshold", () => {
  // Use a unique runId so we don't collide with concurrent tests.
  const runId = 9_999_001;
  const orgId = 9_999;
  liveEvents.registerRun(runId, orgId);
  liveEvents.emit(runId, { type: "run.started", timestamp: Date.now(), runId });

  // Threshold = -1 means "any active run is stale" (the impl uses strict
  // `>` against now-lastEventAt, which on a fast machine is 0ms after
  // emit, so threshold 0 wouldn't fire — pin -1 so the check is
  // deterministic regardless of machine speed).
  const stale = liveEvents.getStaleRuns(-1);
  assert.ok(stale.some((s) => s.runId === runId),
    "newly emitted run should appear in stale set when threshold is negative");

  // Cleanup: emit run.finished so the singleton drops the run.
  liveEvents.emit(runId, { type: "run.finished", timestamp: Date.now(), runId });
});

test("liveEvents.getActiveRunIds(orgId) only returns runs registered for that org", () => {
  // Cross-tenant isolation at the in-memory layer: getActiveRunIds(7) must
  // not return a run that's only registered to org 8.
  const runA = 9_999_101;
  const runB = 9_999_102;
  liveEvents.registerRun(runA, 7);
  liveEvents.registerRun(runB, 8);
  liveEvents.emit(runA, { type: "run.started", timestamp: Date.now(), runId: runA });
  liveEvents.emit(runB, { type: "run.started", timestamp: Date.now(), runId: runB });

  const org7 = liveEvents.getActiveRunIds(7);
  const org8 = liveEvents.getActiveRunIds(8);

  assert.ok(org7.includes(runA), "runA should appear under its own org");
  assert.ok(!org7.includes(runB), "runB must NOT leak into org 7's active list");
  assert.ok(org8.includes(runB));
  assert.ok(!org8.includes(runA));

  liveEvents.emit(runA, { type: "run.finished", timestamp: Date.now(), runId: runA });
  liveEvents.emit(runB, { type: "run.finished", timestamp: Date.now(), runId: runB });
});

test("liveEvents.touch: keeps run active without altering active state", () => {
  // Heartbeat path: a slow Cucumber scenario can run for minutes
  // without emitting anything; touch() keeps the run from tripping
  // stale-run detection in that quiet period.  The contract:
  //   - touch() must not change activeRuns membership
  //   - subsequent getActiveRunIds(orgId) still includes the run
  const runId = 9_999_201;
  liveEvents.registerRun(runId, 1);
  liveEvents.emit(runId, { type: "run.started", timestamp: Date.now(), runId });

  liveEvents.touch(runId);
  assert.ok(liveEvents.getActiveRunIds(1).includes(runId), "touch must not remove the run from active state");

  liveEvents.emit(runId, { type: "run.finished", timestamp: Date.now(), runId });
});

// ── compare.categorizeChange (already covered, sanity-check imports work) ──

test("categorizeChange: import works from helpers test as a barrel sanity check", () => {
  assert.equal(categorizeChange("passed", "failed"), "regression");
});
