/**
 * Unit tests for the audit-export pure helpers (no DB, no network).
 *
 *  - formatBatchNdjson: the wire format a SIEM receives. Must be valid NDJSON
 *    and carry the chain hashes so the receiver can verify integrity.
 *  - sanitizeDeliveryError: the repo's PII/secret-in-logs rule forbids echoing
 *    raw upstream bodies / URLs / tokens; this pins that the stored/returned
 *    error is a low-cardinality token only.
 *  - s3KeyFor: object-key layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBatchNdjson,
  sanitizeDeliveryError,
  s3KeyFor,
} from "../audit-export.js";

const rows = [
  {
    id: "10",
    org_id: 5,
    user_id: 2,
    action: "run.delete",
    target_type: "run",
    target_id: "99",
    detail: { suite: "checkout" },
    created_at: new Date("2026-06-10T00:00:00.000Z"),
    prev_hash: "a".repeat(64),
    entry_hash: "b".repeat(64),
  },
  {
    id: "11",
    org_id: 5,
    user_id: null,
    action: "settings.update",
    target_type: null,
    target_id: null,
    detail: null,
    created_at: new Date("2026-06-10T00:01:00.000Z"),
    prev_hash: "b".repeat(64),
    entry_hash: "c".repeat(64),
  },
];

test("formatBatchNdjson emits one valid JSON object per line", () => {
  const out = formatBatchNdjson(rows);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.id, "10");
  assert.equal(first.action, "run.delete");
  assert.deepEqual(first.detail, { suite: "checkout" });
  assert.equal(first.created_at, "2026-06-10T00:00:00.000Z");
  // The chain hashes must be present so the receiver can verify integrity.
  assert.equal(first.prev_hash, "a".repeat(64));
  assert.equal(first.entry_hash, "b".repeat(64));
  const second = JSON.parse(lines[1]);
  assert.equal(second.user_id, null);
  assert.equal(second.detail, null);
});

test("formatBatchNdjson returns empty string for an empty batch", () => {
  assert.equal(formatBatchNdjson([]), "");
});

test("sanitizeDeliveryError keeps only low-cardinality, non-sensitive tokens", () => {
  assert.equal(sanitizeDeliveryError(new Error("HTTP 503")), "HTTP 503");

  const timeout = new Error("operation timed out");
  assert.equal(sanitizeDeliveryError(timeout), "request timed out");

  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(sanitizeDeliveryError(abort), "request timed out");

  const econn = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(sanitizeDeliveryError(econn), "connection error (ECONNREFUSED)");

  // A raw upstream body / arbitrary message must NOT be echoed.
  const leaky = new Error('{"token":"sk-secret","detail":"internal hostname db-prod-1"}');
  assert.equal(sanitizeDeliveryError(leaky), "delivery failed");

  assert.equal(sanitizeDeliveryError("a string"), "delivery failed");
});

test("s3KeyFor lays out keys under <prefix>/audit/org-<id>/ and trims slashes", () => {
  assert.equal(s3KeyFor("siem", 7, "10", "20"), "siem/audit/org-7/10-20.ndjson");
  assert.equal(s3KeyFor("/siem/logs/", 7, "10", "20"), "siem/logs/audit/org-7/10-20.ndjson");
  assert.equal(s3KeyFor(null, 7, "10", "20"), "audit/org-7/10-20.ndjson");
  assert.equal(s3KeyFor("", 7, "10", "20"), "audit/org-7/10-20.ndjson");
});
