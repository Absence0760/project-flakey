/**
 * AI clustering unit tests.
 *
 * clusterBySimilarity() groups an org's distinct failed errors into root-cause
 * clusters BEFORE any model call — it's the cost-free, works-AI-off half of the
 * /analyze/clusters endpoint. It's a pure, single-pass greedy function built on
 * computeSimilarity (token-Jaccard), so it has no DB or model dependency. These
 * tests pin its contract: a regression here silently changes how every org's
 * failures get grouped (and which clusters get an AI theme).
 *
 * The companion analyzeCluster() makes a model call, so it's exercised via the
 * route/integration tests, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterBySimilarity } from "../ai.js";

const text = (s: string) => s;

// ── Empty / trivial ──────────────────────────────────────────────────────

test("clusterBySimilarity: empty input → []", () => {
  assert.deepEqual(clusterBySimilarity<string>([], text, 0.4), []);
});

test("clusterBySimilarity: single item → one cluster of one", () => {
  assert.deepEqual(clusterBySimilarity(["lonely error"], text, 0.4), [["lonely error"]]);
});

// ── Grouping behaviour ─────────────────────────────────────────────────────

test("clusterBySimilarity: near-identical messages land in one cluster", () => {
  const items = [
    "Error: ENOENT: no such file or directory, open '/tmp/abc.txt'",
    "Error: ENOENT: no such file or directory, open '/tmp/xyz.txt'",
    "Error: ENOENT: no such file or directory, open '/tmp/123.txt'",
  ];
  const clusters = clusterBySimilarity(items, text, 0.4);
  assert.equal(clusters.length, 1, "the three ENOENT errors should share one cluster");
  assert.equal(clusters[0].length, 3);
});

test("clusterBySimilarity: clearly different messages land in separate clusters", () => {
  const items = [
    "TypeError: Cannot read property 'foo' of undefined",
    "AssertionError: expected 200 to equal 201",
    "Error: ENOENT: no such file or directory, open '/tmp/abc.txt'",
  ];
  const clusters = clusterBySimilarity(items, text, 0.4);
  assert.equal(clusters.length, 3, "three unrelated errors should each get their own cluster");
});

test("clusterBySimilarity: mixed input groups like-with-like", () => {
  const items = [
    "Timeout waiting for selector .btn after 5000ms",
    "TypeError: Cannot read property 'foo' of undefined",
    "Timeout waiting for selector .menu after 5000ms",
    "TypeError: Cannot read property 'bar' of undefined",
  ];
  const clusters = clusterBySimilarity(items, text, 0.4);
  assert.equal(clusters.length, 2, "two timeout + two typeerror → two clusters");
  // Each cluster has two members; total members preserved.
  assert.deepEqual(clusters.map((c) => c.length).sort(), [2, 2]);
});

// ── Threshold boundary ─────────────────────────────────────────────────────

test("clusterBySimilarity: threshold is inclusive (>= joins)", () => {
  // {a, b} vs {a, c} → computeSimilarity = 0.5 exactly. At threshold 0.5 the
  // second item must JOIN the first (>=), giving one cluster.
  const join = clusterBySimilarity(["a b", "a c"], text, 0.5);
  assert.equal(join.length, 1, "similarity == threshold should join (inclusive)");
  assert.equal(join[0].length, 2);

  // Just above 0.5, the same pair must split into two clusters.
  const split = clusterBySimilarity(["a b", "a c"], text, 0.51);
  assert.equal(split.length, 2, "similarity < threshold should split");
});

test("clusterBySimilarity: threshold 0 puts everything in the first cluster", () => {
  // Every comparison scores >= 0, so each item joins the first cluster.
  const items = ["wildly different one", "totally unrelated two", "nothing alike three"];
  const clusters = clusterBySimilarity(items, text, 0);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 3);
});

test("clusterBySimilarity: threshold above 1 makes every item its own cluster", () => {
  // computeSimilarity maxes at 1, so nothing ever joins — even identical items.
  const items = ["same", "same", "same"];
  const clusters = clusterBySimilarity(items, text, 1.01);
  assert.equal(clusters.length, 3);
});

// ── Representative semantics ───────────────────────────────────────────────

test("clusterBySimilarity: compares against the cluster SEED, not later members", () => {
  // A is the seed. B is similar to A (joins). C is similar to B but NOT to A —
  // because comparison is against the seed (A), C must NOT chain into A's
  // cluster; it starts its own.
  const seed = "alpha beta gamma";
  const near = "alpha beta delta"; // shares {alpha, beta} with seed → 2/3 ≈ 0.67
  const far = "delta epsilon zeta"; // shares {delta} with `near`, nothing with seed
  const clusters = clusterBySimilarity([seed, near, far], text, 0.4);
  assert.equal(clusters.length, 2, "far must not chain in via near — compared against seed only");
  assert.deepEqual(clusters[0], [seed, near]);
  assert.deepEqual(clusters[1], [far]);
});

test("clusterBySimilarity: getText projection is used for similarity", () => {
  // Cluster objects by a sub-field, ignoring noise in other fields.
  const items = [
    { msg: "connection refused", id: 1 },
    { msg: "connection refused", id: 2 },
    { msg: "permission denied", id: 3 },
  ];
  const clusters = clusterBySimilarity(items, (i) => i.msg, 0.4);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].map((i) => i.id), [1, 2]);
  assert.deepEqual(clusters[1].map((i) => i.id), [3]);
});

// ── Determinism ────────────────────────────────────────────────────────────

test("clusterBySimilarity: deterministic for a fixed input order", () => {
  const items = [
    "Timeout waiting for selector .btn",
    "Timeout waiting for selector .menu",
    "AssertionError: expected true to be false",
    "Timeout waiting for selector .nav",
    "AssertionError: expected 1 to be 2",
  ];
  const a = clusterBySimilarity(items, text, 0.4);
  const b = clusterBySimilarity(items, text, 0.4);
  assert.deepEqual(a, b, "same input order must yield identical clustering across calls");
});

test("clusterBySimilarity: every input item appears exactly once across clusters", () => {
  const items = ["one alpha", "one beta", "two gamma", "three delta", "two epsilon"];
  const clusters = clusterBySimilarity(items, text, 0.4);
  const flat = clusters.flat();
  assert.equal(flat.length, items.length, "no item lost or duplicated");
  assert.deepEqual([...flat].sort(), [...items].sort());
});
