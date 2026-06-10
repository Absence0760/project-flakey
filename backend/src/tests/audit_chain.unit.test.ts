/**
 * Unit tests for the audit hash-chain primitives (no DB).
 *
 * canonicalJson and computeEntryHash are the versioned contract the whole
 * tamper-evidence scheme rests on: append (audit.ts) and verify must hash the
 * exact same bytes. These pin determinism (key-order independence) and
 * sensitivity (any content change moves the hash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_HASH,
  canonicalJson,
  computeEntryHash,
  type AuditChainFields,
} from "../audit-chain.js";

test("GENESIS_HASH is 64 hex zeros", () => {
  assert.equal(GENESIS_HASH, "0".repeat(64));
  assert.match(GENESIS_HASH, /^[0-9a-f]{64}$/);
});

test("canonicalJson is independent of object key order", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(
    canonicalJson({ z: { y: 1, x: 2 }, a: [3, 2, 1] }),
    canonicalJson({ a: [3, 2, 1], z: { x: 2, y: 1 } })
  );
});

test("canonicalJson preserves array order (arrays are ordered)", () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test("canonicalJson handles null/undefined/scalars", () => {
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(42), "42");
  assert.equal(canonicalJson(true), "true");
});

const base: AuditChainFields = {
  id: 100,
  orgId: 7,
  userId: 3,
  action: "run.deleted",
  targetType: "run",
  targetId: "42",
  detail: { reason: "retention" },
  createdAt: "2026-06-10T00:00:00.000Z",
};

test("computeEntryHash is deterministic for identical input", () => {
  assert.equal(computeEntryHash(GENESIS_HASH, base), computeEntryHash(GENESIS_HASH, base));
});

test("computeEntryHash output is a sha256 hex digest", () => {
  assert.match(computeEntryHash(GENESIS_HASH, base), /^[0-9a-f]{64}$/);
});

test("computeEntryHash changes when the predecessor changes", () => {
  const other = "f".repeat(64);
  assert.notEqual(computeEntryHash(GENESIS_HASH, base), computeEntryHash(other, base));
});

test("computeEntryHash is sensitive to every bound field", () => {
  const h0 = computeEntryHash(GENESIS_HASH, base);
  const mutations: Partial<AuditChainFields>[] = [
    { id: 101 },
    { orgId: 8 },
    { userId: 4 },
    { userId: null },
    { action: "run.archived" },
    { targetType: "test" },
    { targetId: "43" },
    { detail: { reason: "manual" } },
    { detail: null },
    { createdAt: "2026-06-10T00:00:00.001Z" },
  ];
  for (const m of mutations) {
    assert.notEqual(
      computeEntryHash(GENESIS_HASH, { ...base, ...m }),
      h0,
      `mutating ${JSON.stringify(m)} must change the hash`
    );
  }
});

test("computeEntryHash is independent of detail key order (jsonb round-trip safety)", () => {
  const a = computeEntryHash(GENESIS_HASH, { ...base, detail: { a: 1, b: 2 } });
  const b = computeEntryHash(GENESIS_HASH, { ...base, detail: { b: 2, a: 1 } });
  assert.equal(a, b);
});
