/**
 * Unit coverage for pagerDutyDedupKey — the PagerDuty Events API dedup_key for a
 * run's auto-triggered incident. Pure function, no DB.
 *
 * Regression: the key was a plain `flakey-${orgId}-${suite}-${branch}` join, so
 * two different suite/branch pairs whose hyphens line up at the boundary
 * produced the SAME key — PagerDuty would merge the two unrelated incidents and
 * suppress the second page. The key must be injective in (orgId, suite, branch)
 * while still being stable for repeat runs of the same suite+branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pagerDutyDedupKey } from "../integrations/pagerduty.js";

test("the same suite+branch always produces the same key (intended dedup)", () => {
  assert.equal(
    pagerDutyDedupKey(1, "api-tests", "main"),
    pagerDutyDedupKey(1, "api-tests", "main"),
    "repeat failures of the same suite+branch must dedup to one incident",
  );
});

test("hyphen-boundary collision is gone: different suite/branch pairs differ", () => {
  // The exact collision the plain join produced: both used to yield
  // "flakey-1-api-tests-main".
  assert.notEqual(
    pagerDutyDedupKey(1, "api-tests", "main"),
    pagerDutyDedupKey(1, "api", "tests-main"),
    "distinct (suite,branch) pairs must not share a dedup key",
  );
});

test("a branch containing a slash is escaped, not treated as a separator", () => {
  // feature/x must not collide with a suite/branch split at that slash.
  assert.notEqual(
    pagerDutyDedupKey(1, "e2e", "feature/login"),
    pagerDutyDedupKey(1, "e2e/feature", "login"),
  );
  // And it stays stable for itself.
  assert.equal(
    pagerDutyDedupKey(1, "e2e", "feature/login"),
    pagerDutyDedupKey(1, "e2e", "feature/login"),
  );
});

test("org id participates in the key (cross-org runs never share an incident)", () => {
  assert.notEqual(
    pagerDutyDedupKey(1, "smoke", "main"),
    pagerDutyDedupKey(2, "smoke", "main"),
  );
});

test("injective across a batch of realistic hyphenated names — no collisions", () => {
  const cases: Array<[number, string, string]> = [
    [1, "api-tests", "main"],
    [1, "api", "tests-main"],
    [1, "api-tests", "release-1.2"],
    [1, "api", "tests-release-1.2"],
    [1, "e2e", "feature/login"],
    [1, "e2e-feature", "login"],
    [2, "api-tests", "main"],
  ];
  const keys = cases.map((c) => pagerDutyDedupKey(...c));
  assert.equal(new Set(keys).size, keys.length, "every distinct input must map to a distinct key");
});
