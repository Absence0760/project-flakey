import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { register } from "../mocha.ts";

/**
 * Unit-tests the Mocha/Cypress reporter adapter (src/mocha.ts).
 *
 * The adapter exports a `register(on, config)` function — `on` is the
 * Cypress plugin event registrar — instead of a class. We mock `on`
 * with a Map<event, handler[]> and drive the handlers ourselves to
 * assert the events that flow through the LiveClient.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const SUITE = "cypress-suite";
const ASSIGNED_RUN_ID = 7373;
const ASSIGNED_CI_RUN_ID = "live-cy-deadbeef";

const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    if (url.endsWith("/live/start")) {
      return new Response(
        JSON.stringify({ id: ASSIGNED_RUN_ID, ci_run_id: ASSIGNED_CI_RUN_ID }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  });
  return { fn, calls };
}

function flattenEvents(calls: Capture[]): any[] {
  const out: any[] = [];
  for (const c of calls) {
    if (!c.url.includes("/events")) continue;
    const body = JSON.parse(c.opts.body as string);
    if (Array.isArray(body)) out.push(...body);
  }
  return out;
}

/**
 * Simulates Cypress's plugin `on` registrar. Each handler is stored by
 * event name; the first handler wins for any given event because that's
 * what Cypress 15 actually does for `after:run`. The test driver below
 * ignores extra handlers consistent with single-registration.
 */
function makeOn() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const on = (event: string, handler: (...args: any[]) => any) => {
    handlers.set(event, handler);
  };
  return { on, handlers };
}

let fetchMock: ReturnType<typeof makeFetchMock>;
beforeEach(() => {
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
  // Ensure no stray env from other tests.
  delete process.env.FLAKEY_API_URL;
  delete process.env.FLAKEY_API_KEY;
  delete process.env.FLAKEY_LIVE_RUN_ID;
  delete process.env.CI_RUN_ID;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLAKEY_API_URL;
  delete process.env.FLAKEY_API_KEY;
  delete process.env.FLAKEY_LIVE_RUN_ID;
  delete process.env.CI_RUN_ID;
});

test("register() is a no-op when url + apiKey are missing (no handlers attached)", () => {
  const { on, handlers } = makeOn();
  register(on as any, { suite: SUITE });
  assert.equal(handlers.size, 0,
    "without creds, register() should not wire any handlers");
});

test("before:run POSTs /live/start, sets FLAKEY_LIVE_RUN_ID + CI_RUN_ID env, sends run.started", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });

  await handlers.get("before:run")!();
  // Force-flush the LiveClient queue by invoking after:run.
  await handlers.get("after:run")!({ totalFailed: 0, totalPassed: 1, totalTests: 1 });

  const startCall = fetchMock.calls.find((c) => c.url.endsWith("/live/start"));
  assert.ok(startCall, "expected POST /live/start");
  const startBody = JSON.parse(startCall.opts.body as string);
  assert.equal(startBody.suite, SUITE);

  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, String(ASSIGNED_RUN_ID),
    "FLAKEY_LIVE_RUN_ID env should be set so sibling Mocha reporter picks up the run id");
  assert.equal(process.env.CI_RUN_ID, ASSIGNED_CI_RUN_ID,
    "CI_RUN_ID env should be set so the post-run upload merges into the placeholder");

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events[0]?.type, "run.started");
});

test("config.environment is forwarded to /live/start", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE, environment: "qa" });
  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  const startBody = JSON.parse(
    fetchMock.calls.find((c) => c.url.endsWith("/live/start"))!.opts.body as string,
  );
  assert.equal(startBody.environment, "qa");
});

test("FLAKEY_ENV env var is the fallback for environment when config doesn't set it", async () => {
  process.env.FLAKEY_ENV = "stage";
  try {
    const { on, handlers } = makeOn();
    register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
    await handlers.get("before:run")!();
    await handlers.get("after:run")!({ totalFailed: 0 });

    const startBody = JSON.parse(
      fetchMock.calls.find((c) => c.url.endsWith("/live/start"))!.opts.body as string,
    );
    assert.equal(startBody.environment, "stage");
  } finally {
    delete process.env.FLAKEY_ENV;
  }
});

test("cypressConfig.env.name is the LAST fallback for environment (cypress run --env name=qa)", async () => {
  // When a Cypress consumer wires this adapter directly (not via
  // setupFlakey), they pass the cypress config as a third arg so the
  // adapter can see `--env name=qa` / `--env environment=qa`. Without
  // this, the run label silently drops and the dashboard groups under
  // an empty environment string — confusing for any consumer using the
  // standard Cypress `--env name=` convention.
  const { on, handlers } = makeOn();
  register(
    on as any,
    { url: URL, apiKey: API_KEY, suite: SUITE },
    { env: { name: "qa-from-cypress-cli" } },
  );
  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  const startBody = JSON.parse(
    fetchMock.calls.find((c) => c.url.endsWith("/live/start"))!.opts.body as string,
  );
  assert.equal(startBody.environment, "qa-from-cypress-cli");
});

test("cypressConfig.env.environment is preferred over cypressConfig.env.name (matches plugin.ts setupFlakey)", async () => {
  // Both keys are Cypress conventions for labelling environments.
  // Match the existing setupFlakey resolution order: `environment` wins
  // over `name` so a consumer using both gets the more-specific key.
  const { on, handlers } = makeOn();
  register(
    on as any,
    { url: URL, apiKey: API_KEY, suite: SUITE },
    { env: { name: "fallback", environment: "preferred" } },
  );
  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  const startBody = JSON.parse(
    fetchMock.calls.find((c) => c.url.endsWith("/live/start"))!.opts.body as string,
  );
  assert.equal(startBody.environment, "preferred");
});

test("FLAKEY_ENV wins over cypressConfig.env.name (env var beats CLI flag)", async () => {
  process.env.FLAKEY_ENV = "from-env";
  try {
    const { on, handlers } = makeOn();
    register(
      on as any,
      { url: URL, apiKey: API_KEY, suite: SUITE },
      { env: { name: "from-cypress-cli" } },
    );
    await handlers.get("before:run")!();
    await handlers.get("after:run")!({ totalFailed: 0 });

    const startBody = JSON.parse(
      fetchMock.calls.find((c) => c.url.endsWith("/live/start"))!.opts.body as string,
    );
    assert.equal(
      startBody.environment,
      "from-env",
      "an explicit FLAKEY_ENV should beat a Cypress --env flag",
    );
  } finally {
    delete process.env.FLAKEY_ENV;
  }
});

test("before:spec emits spec.started with spec.relative", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
  await handlers.get("before:run")!();
  handlers.get("before:spec")!({ relative: "cypress/e2e/auth/login.cy.ts" });
  await handlers.get("after:run")!({ totalFailed: 0 });

  const specStart = flattenEvents(fetchMock.calls).find((e) => e.type === "spec.started");
  assert.ok(specStart);
  assert.equal(specStart.spec, "cypress/e2e/auth/login.cy.ts");
});

test("after:spec emits spec.finished with normalized stats (total/passed/failed/skipped)", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
  await handlers.get("before:run")!();
  handlers.get("before:spec")!({ relative: "cypress/e2e/auth/login.cy.ts" });
  handlers.get("after:spec")!(
    { relative: "cypress/e2e/auth/login.cy.ts" },
    { stats: { passes: 2, failures: 1, skipped: 1, tests: 4 } },
  );
  await handlers.get("after:run")!({ totalFailed: 1 });

  const specFinished = flattenEvents(fetchMock.calls).find((e) => e.type === "spec.finished");
  assert.ok(specFinished);
  assert.equal(specFinished.spec, "cypress/e2e/auth/login.cy.ts");
  assert.deepEqual(specFinished.stats, { total: 4, passed: 2, failed: 1, skipped: 1 });
});

test("after:run emits run.finished as the last event", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
  await handlers.get("before:run")!();
  handlers.get("before:spec")!({ relative: "a.cy.ts" });
  await handlers.get("after:run")!({ totalFailed: 0, totalPassed: 1, totalTests: 1 });

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events.at(-1)?.type, "run.finished");
});

test("before:run is idempotent: a second invocation does NOT create a second LiveClient or duplicate /live/start", async () => {
  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
  await handlers.get("before:run")!();
  await handlers.get("before:run")!(); // Cypress 15+ fires before:run twice
  await handlers.get("after:run")!({ totalFailed: 0 });

  const startCalls = fetchMock.calls.filter((c) => c.url.endsWith("/live/start"));
  assert.equal(startCalls.length, 1,
    "the startPromise guard should ensure only one /live/start across duplicate before:run invocations");

  const runStarteds = flattenEvents(fetchMock.calls).filter((e) => e.type === "run.started");
  assert.equal(runStarteds.length, 1,
    "run.started should be sent exactly once even when before:run fires twice");
});

test("preset FLAKEY_LIVE_RUN_ID skips /live/start and uses the supplied run id", async () => {
  process.env.FLAKEY_LIVE_RUN_ID = "9999";
  try {
    const { on, handlers } = makeOn();
    register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });
    await handlers.get("before:run")!();
    handlers.get("before:spec")!({ relative: "x.cy.ts" });
    await handlers.get("after:run")!({ totalFailed: 0 });

    assert.equal(
      fetchMock.calls.find((c) => c.url.endsWith("/live/start")),
      undefined,
      "preset FLAKEY_LIVE_RUN_ID should bypass /live/start",
    );
    const eventCall = fetchMock.calls.find((c) => c.url.includes("/events"));
    assert.ok(eventCall?.url.endsWith("/live/9999/events"));
  } finally {
    delete process.env.FLAKEY_LIVE_RUN_ID;
  }
});

test("installAfterRun: false skips wiring after:run on the registrar and returns the teardown function", async () => {
  const { on, handlers } = makeOn();
  const teardown = register(on as any, {
    url: URL, apiKey: API_KEY, suite: SUITE, installAfterRun: false,
  });

  assert.ok(typeof teardown === "function",
    "installAfterRun: false should return the teardown handler");
  assert.equal(handlers.has("after:run"), false,
    "register() must not register its own after:run when installAfterRun is false");

  await handlers.get("before:run")!();
  // Caller invokes the returned teardown inside its combined handler.
  await teardown!({ totalFailed: 0 });

  const events = flattenEvents(fetchMock.calls);
  assert.equal(events.at(-1)?.type, "run.finished");
});

test("FLAKEY_API_URL / FLAKEY_API_KEY env vars work without explicit config", async () => {
  process.env.FLAKEY_API_URL = URL;
  process.env.FLAKEY_API_KEY = API_KEY;
  try {
    const { on, handlers } = makeOn();
    register(on as any, { suite: SUITE });
    assert.equal(handlers.size > 0, true,
      "register should wire handlers when env-only credentials are present");

    await handlers.get("before:run")!();
    await handlers.get("after:run")!({ totalFailed: 0 });

    // startsWith(URL) without the path separator would also match
    // https://api.example.com.attacker.com/... — pin the trailing slash
    // so an env-injected look-alike host doesn't satisfy the assertion.
    // (CodeQL js/incomplete-url-substring-sanitization).
    assert.ok(fetchMock.calls.find((c) => c.url.startsWith(URL + "/")),
      "fetch should hit the URL provided via env");
  } finally {
    delete process.env.FLAKEY_API_URL;
    delete process.env.FLAKEY_API_KEY;
  }
});

// --- Malformed /live/start response handling -----------------------------
//
// Cypress spawns the Mocha reporter in a SEPARATE process from
// setupNodeEvents; the numeric run id is handed off to it via tmpdir /
// homedir files. A compromised or buggy /live/start endpoint could return
// an `id` field that isn't a finite positive integer (a string, null, an
// object, NaN, or unparseable JSON). The adapter must REJECT such a value
// at the boundary so nothing surprising is smuggled into process.env, the
// handoff files, or the downstream /events URL — and register() must keep
// running instead of throwing the consumer's whole Cypress run.

/** Builds a fetch mock whose /live/start returns a caller-supplied body. */
function makeStartBodyMock(bodyMaker: () => Response): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    if (url.endsWith("/live/start")) return bodyMaker();
    return new Response("{}", { status: 200 });
  });
  return { fn, calls };
}

/** Runs `fn` with console.warn + console.error captured; restores after. */
async function captureConsole(fn: () => Promise<void>): Promise<{ warn: string[]; error: string[] }> {
  const warn: string[] = [];
  const error: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => { warn.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { error.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  return { warn, error };
}

test("malformed /live/start (unparseable JSON): no run id, no events, register() does not throw", async () => {
  const mockFetch = makeStartBodyMock(
    () => new Response("<html>502 Bad Gateway</html>", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE, verbose: true });

  const { error } = await captureConsole(async () => {
    // Must not reject even though res.json() throws on the bad body.
    await handlers.get("before:run")!();
    await handlers.get("after:run")!({ totalFailed: 0 });
  });

  // res.json() throwing lands in the outer catch, which logs an error.
  assert.ok(
    error.some((l) => l.includes("[flakey-live] Failed to start live run")),
    "an unparseable /live/start body should be logged as a start failure",
  );
  // No run id was resolved → no LiveClient → no /events traffic.
  assert.equal(
    mockFetch.calls.find((c) => c.url.includes("/events")),
    undefined,
    "a malformed start response must not produce any /events calls",
  );
  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, undefined,
    "a malformed start response must not set FLAKEY_LIVE_RUN_ID");
});

test("/live/start with {id:'uuid'} (string): id validation rejects, no events, warns in verbose", async () => {
  const mockFetch = makeStartBodyMock(
    () => new Response(JSON.stringify({ id: "5d8f-uuid-not-a-number" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE, verbose: true });

  const { warn } = await captureConsole(async () => {
    await handlers.get("before:run")!();
    await handlers.get("after:run")!({ totalFailed: 0 });
  });

  assert.ok(
    warn.some((l) => l.includes("non-numeric id")),
    "a string id should be rejected with a verbose warning",
  );
  assert.equal(
    mockFetch.calls.find((c) => c.url.includes("/events")),
    undefined,
    "a string id must not be smuggled into a /events URL",
  );
  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, undefined,
    "a string id must not be written to FLAKEY_LIVE_RUN_ID");
});

test("/live/start with {id:null}: id validation rejects, no events", async () => {
  const mockFetch = makeStartBodyMock(
    () => new Response(JSON.stringify({ id: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  // Non-verbose: register() must STILL reject cleanly and stay silent.
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });

  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  assert.equal(
    mockFetch.calls.find((c) => c.url.includes("/events")),
    undefined,
    "a null id must not produce any /events calls",
  );
  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, undefined,
    "a null id must not be written to FLAKEY_LIVE_RUN_ID");
});

test("/live/start with {id:999} and no ci_run_id: CI_RUN_ID env is NOT set", async () => {
  const mockFetch = makeStartBodyMock(
    () => new Response(JSON.stringify({ id: 999 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });

  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  // The valid numeric id IS adopted...
  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, "999",
    "a valid numeric id should be adopted as the run id");
  // ...but with no ci_run_id in the response, CI_RUN_ID stays unset so
  // the post-run upload doesn't merge into a bogus CI run.
  assert.equal(process.env.CI_RUN_ID, undefined,
    "a missing ci_run_id must leave process.env.CI_RUN_ID unset");
});

test("/live/start with {id:999, ci_run_id:123} (number): ci_run_id is NOT assigned to env", async () => {
  const mockFetch = makeStartBodyMock(
    () => new Response(JSON.stringify({ id: 999, ci_run_id: 123 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });

  await handlers.get("before:run")!();
  await handlers.get("after:run")!({ totalFailed: 0 });

  assert.equal(process.env.FLAKEY_LIVE_RUN_ID, "999",
    "the valid numeric id is still adopted");
  // ci_run_id is only honoured when it's a string. A numeric ci_run_id
  // must not be coerced into process.env.CI_RUN_ID.
  assert.equal(process.env.CI_RUN_ID, undefined,
    "a non-string ci_run_id must not be written to process.env.CI_RUN_ID");
});

test("valid /live/start writes a readable run-id to the homedir fallback handoff file", async () => {
  // The Mocha reporter in Cypress 15+ can live in a process tree that
  // shares no ancestor pid with setupNodeEvents; the homedir singleton
  // (~/.flakey-reporter/latest-run-id) is the fallback it reads. Assert
  // the file is written with the resolved numeric id during the run, then
  // cleaned up by after:run.
  const HOME_FILE = join(homedir(), ".flakey-reporter", "latest-run-id");
  // Pre-clean any stray file from an aborted prior run so the assertion
  // reflects THIS run's write, not leftover state.
  try { rmSync(HOME_FILE, { force: true }); } catch { /* ignore */ }

  const mockFetch = makeStartBodyMock(
    () => new Response(JSON.stringify({ id: ASSIGNED_RUN_ID, ci_run_id: ASSIGNED_CI_RUN_ID }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = mockFetch.fn as unknown as typeof fetch;

  const { on, handlers } = makeOn();
  register(on as any, { url: URL, apiKey: API_KEY, suite: SUITE });

  try {
    await handlers.get("before:run")!();

    // During the run, the homedir handoff file holds the numeric run id
    // the cross-process Mocha reporter will read.
    const written = readFileSync(HOME_FILE, "utf8");
    assert.equal(written, String(ASSIGNED_RUN_ID),
      "the homedir fallback file must contain the resolved numeric run id");

    // after:run unlinks the handoff files.
    await handlers.get("after:run")!({ totalFailed: 0 });
    assert.throws(
      () => readFileSync(HOME_FILE, "utf8"),
      "after:run should remove the homedir handoff file",
    );
  } finally {
    // Belt-and-suspenders: never leave the file behind if an assertion
    // above threw before after:run ran.
    try { rmSync(HOME_FILE, { force: true }); } catch { /* ignore */ }
  }
});
