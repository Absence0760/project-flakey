import { test } from "node:test";
import { strict as assert } from "node:assert";

import { snapshotFileName } from "../plugin.ts";

/**
 * Snapshot filenames double as the on-disk corpus name AND the storage key the
 * backend links to a test. The title is truncated to 100 chars for
 * readability, so two scenarios sharing a long prefix (Cucumber
 * "<Feature> <Rule> <scenario>" titles, where the distinguishing leaf is past
 * char 100) used to collide and silently overwrite each other. The full-title
 * hash suffix must make them distinct while keeping the leaf title present for
 * the backend's substring match.
 */

const SPEC = "cypress/e2e/test/tenantBilling/featureFlag/tenantBilling-featureFlags.feature";
// Real-world collision: identical 100+ char prefix, different leaf scenario.
const PREFIX = "Tenant Billing — Notification Settings visibility controlled by feature flag Notification Settings tab appears or disappears depending on whether Tenant Billing is turned on ";
const TITLE_A = PREFIX + "Tenant Admin can reach Notification Settings when the Tenant Billing flag is on";
const TITLE_B = PREFIX + "Tenant Preferences tab is hidden when the Tenant Billing flag is off";

test("two titles sharing the first 100 chars produce DISTINCT filenames", () => {
  const a = snapshotFileName(SPEC, TITLE_A);
  const b = snapshotFileName(SPEC, TITLE_B);
  assert.notEqual(a, b, "long-prefix scenarios must not collide on the same filename");
  assert.match(a, /\.json\.gz$/);
  assert.match(b, /\.json\.gz$/);
});

test("the same title is deterministic (a re-run overwrites its own file, not a sibling's)", () => {
  assert.equal(snapshotFileName(SPEC, TITLE_A), snapshotFileName(SPEC, TITLE_A));
});

test("the hash is an 8-char hex suffix before the extension", () => {
  const name = snapshotFileName(SPEC, TITLE_A);
  assert.match(name, /-[0-9a-f]{8}\.json\.gz$/, "expected a -<8 hex>.json.gz suffix");
});

test("the spec path is flattened (slashes → __) and slashes never leak into the key", () => {
  const name = snapshotFileName(SPEC, "Short title");
  assert.equal(name.includes("/"), false, "no slashes — the filename is a flat storage key");
  assert.match(name, /^cypress__e2e__test__/);
});

test("a short leaf title remains a substring of the filename (backend includes-match still works)", () => {
  // Backend batch match: normalize(filename).includes(normalize(leaf)). The
  // hash is appended AFTER the title, so the leaf is still present.
  const name = snapshotFileName(SPEC, "User can log in with SSO");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  assert.equal(norm(name).includes(norm("User can log in with SSO")), true);
});

test("a very long spec path is capped so the name stays <= 200 chars with the title+hash tail intact", () => {
  // The backend's fixFilename truncates the upload filename at 200 chars. If a
  // long spec path pushed the name past 200, the tail (past the `--`) was cut,
  // the upload handler's indexOf("--") split broke, and the snapshot was stored
  // but never linked to a test row. The spec prefix must yield to keep the
  // `--<title>-<hash>.json.gz` tail whole.
  const longSpec = "cypress/e2e/" + Array.from({ length: 30 }, (_, i) => `deeply-nested-area-${i}`).join("/") + "/spec.feature";
  const title = "Some Feature a reasonably long scenario title that is itself near the hundred char truncation limit yes";
  const name = snapshotFileName(longSpec, title);

  assert.ok(name.length <= 200, `filename must be <= 200 chars, got ${name.length}`);
  // The split-on-"--" tail the backend relies on must be fully present.
  const idx = name.indexOf("--");
  assert.ok(idx >= 0, "the '--' separator must survive");
  const tail = name.slice(idx + 2);
  assert.match(tail, /^[A-Za-z0-9_\- ]+-[0-9a-f]{8}\.json\.gz$/,
    "the <title>-<hash>.json.gz tail must be intact, not truncated");
});
