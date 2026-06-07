/**
 * Bootstrap-admin log redaction.
 *
 * bootstrap-admin.ts used to log the bootstrap admin's email verbatim
 * ("Bootstrap admin alice@acme.com already exists…"), so in a
 * containerised deploy the address was discoverable to anyone with
 * CloudWatch read access (CWE-532). The log lines now carry only the
 * email domain — never the local-part.
 *
 * This is a pure unit test: it stubs a minimal pg.Pool / client so no
 * Postgres connection is needed, captures console.log, and asserts that
 * neither code path (already-exists, freshly-created) leaks the
 * local-part of the email.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { bootstrapAdmin } from "../bootstrap-admin.js";

const LOCAL_PART = "secret-admin-local-part";
const DOMAIN = "acme.example";
const EMAIL = `${LOCAL_PART}@${DOMAIN}`;

async function withCapturedLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function withBootstrapEnv<T>(fn: () => T): T {
  const prevEmail = process.env.FLAKEY_BOOTSTRAP_ADMIN_EMAIL;
  const prevPassword = process.env.FLAKEY_BOOTSTRAP_ADMIN_PASSWORD;
  process.env.FLAKEY_BOOTSTRAP_ADMIN_EMAIL = EMAIL;
  process.env.FLAKEY_BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass-123";
  try {
    return fn();
  } finally {
    if (prevEmail === undefined) delete process.env.FLAKEY_BOOTSTRAP_ADMIN_EMAIL;
    else process.env.FLAKEY_BOOTSTRAP_ADMIN_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.FLAKEY_BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.FLAKEY_BOOTSTRAP_ADMIN_PASSWORD = prevPassword;
  }
}

test("already-exists log line carries the email domain, not the local-part", async () => {
  // Pool whose existence check reports a pre-existing user.
  const pool = {
    query: async () => ({ rows: [{ id: 1 }] }),
  } as unknown as pg.Pool;

  const lines = await withBootstrapEnv(() => withCapturedLog(() => bootstrapAdmin(pool)));

  const joined = lines.join("\n");
  assert.ok(/already exists/.test(joined), `expected an already-exists log line; got: ${joined}`);
  assert.ok(joined.includes(DOMAIN), "domain should appear in the log for operator triage");
  assert.ok(!joined.includes(LOCAL_PART), "the email local-part must never reach the logs");
  assert.ok(!joined.includes(EMAIL), "the full email must never reach the logs");
});

test("created log line carries the email domain, not the local-part", async () => {
  // Existence check returns no rows, then the transactional inserts each
  // return the row the code reads back.
  let call = 0;
  const client = {
    query: async (sql: string) => {
      if (/^\s*BEGIN/i.test(sql) || /^\s*COMMIT/i.test(sql)) return { rows: [] };
      call += 1;
      // users INSERT … RETURNING id, then organizations INSERT … RETURNING id,
      // then org_members INSERT (no RETURNING).
      if (/INSERT INTO users/i.test(sql)) return { rows: [{ id: 42 }] };
      if (/INSERT INTO organizations/i.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    query: async () => ({ rows: [] }), // existence check: no user yet
    connect: async () => client,
  } as unknown as pg.Pool;

  const lines = await withBootstrapEnv(() => withCapturedLog(() => bootstrapAdmin(pool)));
  void call;

  const joined = lines.join("\n");
  assert.ok(/created/.test(joined), `expected a created log line; got: ${joined}`);
  assert.ok(joined.includes(DOMAIN), "domain should appear in the log for operator triage");
  assert.ok(!joined.includes(LOCAL_PART), "the email local-part must never reach the logs");
  assert.ok(!joined.includes(EMAIL), "the full email must never reach the logs");
});
