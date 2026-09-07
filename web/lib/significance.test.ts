/**
 * False-discovery tests.
 *
 * The number this protects is the one on the page that says how many edges are real.
 * A threshold that pure noise clears a third of the time turns a ranked list into a
 * random number generator with a confident label.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { controlFalseDiscovery, twoSidedP } from "./significance.ts";

/** Deterministic standard-normal draws, so the tests do not flake. */
function normals(count: number, seed = 7): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const out: number[] = [];
  while (out.length < count) {
    // Box-Muller
    const u = Math.max(next(), 1e-12);
    const v = next();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

test("one standard error is a coin toss away from meaningless", () => {
  // This is the whole argument for changing the threshold.
  assert.ok(Math.abs(twoSidedP(1) - 0.317) < 0.005);
  assert.ok(Math.abs(twoSidedP(2) - 0.0455) < 0.005);
  assert.ok(twoSidedP(3) < 0.005);
});

test("p-values are symmetric and bounded", () => {
  assert.equal(twoSidedP(1.5), twoSidedP(-1.5));
  assert.ok(twoSidedP(0) <= 1 && twoSidedP(0) > 0.99);
  assert.equal(twoSidedP(NaN), 1);
});

test("pure noise produces few discoveries, where a 1-SE rule produces many", () => {
  const noise = normals(200);
  const result = controlFalseDiscovery(noise, (z) => z, 0.1);
  // A third of 200 pure-noise rows clear one standard error.
  assert.ok(result.naiveCount > 40, `expected ~63 naive flags, got ${result.naiveCount}`);
  // Benjamini-Hochberg should flag almost nothing when there is nothing there.
  assert.ok(
    result.discoveries.length <= 2,
    `expected ~0 discoveries from noise, got ${result.discoveries.length}`,
  );
});

test("a genuine signal is still found", () => {
  // Ten real effects buried in ninety nulls.
  const rows = [...normals(90), ...Array.from({ length: 10 }, (_, i) => 4 + i * 0.1)];
  const result = controlFalseDiscovery(rows, (z) => z, 0.1);
  assert.ok(result.discoveries.length >= 10, `found ${result.discoveries.length}`);
});

test("nothing to find is a legitimate answer", () => {
  const result = controlFalseDiscovery([0.2, -0.4, 0.1], (z) => z, 0.1);
  assert.equal(result.discoveries.length, 0);
  assert.equal(result.cutoff, 0);
  assert.equal(result.expectedFalse, 0);
});

test("expected false flags scale with how many were flagged", () => {
  const rows = Array.from({ length: 20 }, () => 5);
  const result = controlFalseDiscovery(rows, (z) => z, 0.1);
  assert.equal(result.discoveries.length, 20);
  assert.ok(Math.abs(result.expectedFalse - 2) < 1e-9, "10% of 20 flagged is 2");
});

test("a stricter q flags fewer", () => {
  const rows = [...normals(60), 2.5, 2.6, 2.7, 3.5];
  const loose = controlFalseDiscovery(rows, (z) => z, 0.2);
  const strict = controlFalseDiscovery(rows, (z) => z, 0.01);
  assert.ok(strict.discoveries.length <= loose.discoveries.length);
});

test("flags align with the input order", () => {
  const rows = [0.1, 6, 0.2];
  const result = controlFalseDiscovery(rows, (z) => z, 0.1);
  assert.deepEqual(result.flags, [false, true, false]);
  assert.deepEqual(result.discoveries, [6]);
});

test("an empty board is handled", () => {
  const result = controlFalseDiscovery([], (z) => z, 0.1);
  assert.equal(result.tested, 0);
  assert.equal(result.discoveries.length, 0);
});
