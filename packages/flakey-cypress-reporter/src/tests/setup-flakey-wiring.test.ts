/**
 * Regression: setupFlakey() must wire FLAKEY_SNAPSHOTS_ENABLED into
 * config.env so the browser-side support file's `isEnabled()` check
 * returns true and `command:end` actually pushes snapshot steps.
 *
 * The bug this guards against:
 *   - reporter/package.json declared @flakeytesting/cypress-snapshots
 *     only as `peerDependency: ">=0.1.0"` (optional). pnpm resolved
 *     that to the published 0.3.0 from the npm registry into the
 *     reporter's own node_modules, NOT to the local workspace
 *     package. The 0.3.0 build predates the
 *     `config.env.FLAKEY_SNAPSHOTS_ENABLED = enabled` mutation, so
 *     setupFlakey's `await import("@flakeytesting/cypress-snapshots/plugin")`
 *     resolved to a stale function and only registered the
 *     `flakey:saveSnapshot` task without mutating config.env. At
 *     runtime `Cypress.env("FLAKEY_SNAPSHOTS_ENABLED")` returned
 *     `undefined`, isEnabled() returned false, no snapshots
 *     captured, no upload. Silent failure mode.
 *
 *   - Fix: add @flakeytesting/cypress-snapshots: workspace:* to the
 *     reporter's devDependencies (mirrors the existing live-reporter
 *     workspace pin) so pnpm uses the local workspace package, which
 *     does mutate config.env.
 *
 * This test asserts the wiring works end-to-end: call setupFlakey
 * with a fresh fake (on, config) and verify config.env carries the
 * three FLAKEY_SNAPSHOTS_* keys afterwards. If the import ever
 * resolves to a stale snapshots build again, this test fails.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { setupFlakey } from "../plugin.ts";

interface FakeConfig {
  env: Record<string, unknown>;
  reporterOptions?: { url?: string; apiKey?: string; suite?: string };
}

function fakeOn(): (event: string, payload?: unknown) => void {
  return (_event: string, _payload?: unknown) => {
    /* swallow — we only care about config.env mutations */
  };
}

test("setupFlakey wires FLAKEY_SNAPSHOTS_ENABLED into config.env so isEnabled() returns true at runtime", async () => {
  const config: FakeConfig = {
    env: {},
    reporterOptions: { url: "http://localhost:3000", apiKey: "fk_test", suite: "test-suite" },
  };

  await setupFlakey(fakeOn() as unknown as Parameters<typeof setupFlakey>[0], config);

  assert.equal(
    config.env.FLAKEY_SNAPSHOTS_ENABLED,
    true,
    "config.env.FLAKEY_SNAPSHOTS_ENABLED must be true after setupFlakey — " +
      "if this is undefined the reporter is importing a stale snapshots " +
      "build that predates the env-mutation feature.",
  );
  assert.equal(
    typeof config.env.FLAKEY_SNAPSHOTS_MAX_HTML_BYTES,
    "number",
    "per-step HTML cap must be exposed to the support file",
  );
  assert.equal(
    typeof config.env.FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES,
    "number",
    "aggregate bundle cap must be exposed to the support file",
  );
});

test("setupFlakey with snapshots:false skips the env wiring (opt-out preserved)", async () => {
  const config: FakeConfig = {
    env: {},
    reporterOptions: { url: "http://localhost:3000", apiKey: "fk_test", suite: "test-suite" },
  };

  await setupFlakey(fakeOn() as unknown as Parameters<typeof setupFlakey>[0], config, {
    snapshots: false,
  });

  assert.equal(
    config.env.FLAKEY_SNAPSHOTS_ENABLED,
    undefined,
    "snapshots:false must skip the snapshot plugin entirely",
  );
});
