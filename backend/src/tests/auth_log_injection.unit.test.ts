/**
 * Unit test for the log-hardening contract the auth.ts catch blocks rely on.
 *
 * Finding 005-medium-auth-routes-console-error: thirteen catch blocks in
 * routes/auth.ts logged a bare `err` to console.error. Email-send failures
 * (sendVerificationEmail / sendPasswordResetEmail) and Postgres errors can
 * carry a user-supplied email or other CR/LF-bearing text in their message,
 * which an attacker could use to smuggle a forged "\nfake.line=..." entry
 * into the log stream (CWE-117 / js/log-injection). The fix routes every
 * such error through safeLog() — matching the established pattern in
 * routes/uploads.ts and routes/runs.ts.
 *
 * This pins the guarantee safeLog provides for that path: an Error whose
 * message embeds a newline-delimited forged log line (here with an email,
 * the PII the finding calls out) is collapsed onto a single line before it
 * can reach the log formatter. We can't assert the wrapping cheaply at the
 * route level (the catch blocks need a live server + DB to reach), so we pin
 * the contract the route depends on directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeLog } from "../log.js";

test("safeLog collapses CR/LF in an email-send Error so a forged log line can't be injected", () => {
  const err = new Error(
    "Failed to send verification email: connect ECONNREFUSED\nfake.audit=login_success [to: alice@example.com]",
  );
  // Force a deterministic, single-line stack so the assertion isn't
  // dependent on the host's stack-trace formatting.
  err.stack = err.message;

  const out = safeLog(err);

  assert.equal(/[\r\n]/.test(out), false, "output must contain no raw CR/LF");
  assert.equal(out.includes("\nfake.audit"), false, "the forged newline-prefixed entry must be neutralized");
});

test("safeLog handles a non-Error value (e.g. a thrown string) without throwing", () => {
  const out = safeLog("boom\r\nfake.line=1");
  assert.equal(/[\r\n]/.test(out), false);
});
