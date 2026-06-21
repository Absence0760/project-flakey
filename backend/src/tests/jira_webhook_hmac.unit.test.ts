/**
 * Phase 15.4 — inbound Jira webhook HMAC verification (pure unit).
 *
 * verifyJiraSignature is the fail-closed gate on the new external trust
 * boundary, so its edge behaviour is pinned here without a DB or the network:
 *   - a correct sha256=<hmac-of-raw-body> passes,
 *   - any tamper to the body, the secret, or the signature fails,
 *   - missing / malformed / wrong-length signatures fail (never throw),
 *   - the compare is over the EXACT raw bytes (re-serialising must not match).
 * Plus the payload predicates extractIssueKey / isIssueClosed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyJiraSignature,
  extractIssueKey,
  isIssueClosed,
} from "../routes/jira-webhook.js";

const SECRET = "shared-webhook-secret";

function sign(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + createHmac("sha256", secret).update(buf).digest("hex");
}

test("a correctly-signed body verifies", () => {
  const body = Buffer.from(JSON.stringify({ issue: { key: "PROJ-1" } }));
  assert.equal(verifyJiraSignature(body, sign(body), SECRET), true);
});

test("a tampered body fails verification (fail closed)", () => {
  const body = Buffer.from(JSON.stringify({ issue: { key: "PROJ-1" } }));
  const sig = sign(body);
  const tampered = Buffer.from(JSON.stringify({ issue: { key: "PROJ-999" } }));
  assert.equal(verifyJiraSignature(tampered, sig, SECRET), false);
});

test("a signature made with a different secret fails", () => {
  const body = Buffer.from("payload");
  assert.equal(verifyJiraSignature(body, sign(body, "other-secret"), SECRET), false);
});

test("a missing signature header fails (no throw)", () => {
  const body = Buffer.from("payload");
  assert.equal(verifyJiraSignature(body, undefined, SECRET), false);
});

test("an empty secret fails (can't verify ⇒ reject)", () => {
  const body = Buffer.from("payload");
  assert.equal(verifyJiraSignature(body, sign(body), ""), false);
});

test("a malformed signature header fails", () => {
  const body = Buffer.from("payload");
  assert.equal(verifyJiraSignature(body, "not-a-sig", SECRET), false);
  assert.equal(verifyJiraSignature(body, "sha1=abcdef", SECRET), false);
  assert.equal(verifyJiraSignature(body, "sha256=", SECRET), false);
  assert.equal(verifyJiraSignature(body, "sha256=zzzz", SECRET), false); // non-hex
});

test("a wrong-length signature fails without throwing", () => {
  const body = Buffer.from("payload");
  // a too-short but valid-hex digest must be a clean false, not an exception
  assert.equal(verifyJiraSignature(body, "sha256=abcd", SECRET), false);
});

test("verification is over the exact raw bytes (whitespace matters)", () => {
  const compact = Buffer.from('{"issue":{"key":"PROJ-1"}}');
  const sig = sign(compact);
  // The same logical JSON re-serialised with spaces has a different byte string
  // and must NOT verify against the compact signature.
  const spaced = Buffer.from('{ "issue": { "key": "PROJ-1" } }');
  assert.equal(verifyJiraSignature(compact, sig, SECRET), true);
  assert.equal(verifyJiraSignature(spaced, sig, SECRET), false);
});

// ── payload predicates ────────────────────────────────────────────────────

test("extractIssueKey pulls issue.key, null when absent", () => {
  assert.equal(extractIssueKey({ issue: { key: "PROJ-42" } }), "PROJ-42");
  assert.equal(extractIssueKey({ issue: {} }), null);
  assert.equal(extractIssueKey({}), null);
  assert.equal(extractIssueKey(null), null);
  assert.equal(extractIssueKey("nope"), null);
});

test("isIssueClosed is true only for the 'done' status category", () => {
  const closed = { issue: { fields: { status: { statusCategory: { key: "done" } } } } };
  const inProgress = { issue: { fields: { status: { statusCategory: { key: "indeterminate" } } } } };
  const open = { issue: { fields: { status: { statusCategory: { key: "new" } } } } };
  assert.equal(isIssueClosed(closed), true);
  assert.equal(isIssueClosed(inProgress), false);
  assert.equal(isIssueClosed(open), false);
  assert.equal(isIssueClosed({}), false);
  assert.equal(isIssueClosed(null), false);
});
