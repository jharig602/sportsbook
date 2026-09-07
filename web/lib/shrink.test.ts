/**
 * Shrinkage tests.
 *
 * The case that matters most is an efficient market: when nothing is there, every
 * number must collapse to zero rather than leaving the largest noise draw standing
 * at the top of a list labelled "biggest edge".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateShrinkage, shrink } from "./shrink.ts";

function normals(count: number, sd: number, seed = 3): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const out: number[] = [];
  while (out.length < count) {
    const u = Math.max(next(), 1e-12);
    const v = next();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd);
  }
  return out;
}

test("an efficient market shrinks everything to nothing", () => {
  // Every true edge is zero; all scatter is sampling noise.
  const se = 1.6;
  const observed = normals(200, se);
  const s = estimateShrinkage(observed, observed.map(() => se));

  // The property that matters is what happens to the number a person would act on,
  // not the factor itself: the variance estimate is noisy at any realistic sample
  // size, so pinning it to an arbitrary constant tests the seed, not the behaviour.
  const biggest = Math.max(...observed.map(Math.abs));
  assert.ok(biggest > 3, "noise alone produces a large-looking maximum");
  assert.ok(
    Math.abs(shrink(biggest, s)) < 1,
    `the top of the list must not survive: ${biggest} -> ${shrink(biggest, s)}`,
  );
  assert.ok(s.factor < 0.3, `most of the observation should be discarded, got ${s.factor}`);
});

test("real signal survives in proportion to how much there is", () => {
  const se = 1;
  // Genuine spread of 3 points on top of 1 point of noise.
  const truth = normals(300, 3, 5);
  const observed = truth.map((t, i) => t + normals(300, se, 9)[i]);
  const s = estimateShrinkage(observed, observed.map(() => se));
  assert.ok(s.factor > 0.7, `real signal should mostly survive, got ${s.factor}`);
});

test("shrinkage never inflates an estimate", () => {
  const s = estimateShrinkage(normals(50, 2), Array(50).fill(2));
  for (const edge of [-6, -1, 0, 1, 6]) {
    assert.ok(Math.abs(shrink(edge, s)) <= Math.abs(edge) + 1e-9);
  }
});

test("shrinkage preserves sign", () => {
  const s = estimateShrinkage(normals(100, 4, 2), Array(100).fill(1));
  assert.ok(shrink(5, s) > 0);
  assert.ok(shrink(-5, s) < 0);
});

test("too few rows to estimate means shrink to zero", () => {
  const s = estimateShrinkage([4], [1.6]);
  assert.equal(s.factor, 0);
  assert.equal(shrink(4, s), 0);
});

test("the comparison behind the factor is reported", () => {
  const se = 1.5;
  const s = estimateShrinkage(normals(100, se), Array(100).fill(se));
  assert.ok(s.observedSd > 0 && s.noiseSd > 0);
  // With no real signal, observed scatter should be close to noise scatter.
  assert.ok(Math.abs(s.observedSd - s.noiseSd) < 0.6, `${s.observedSd} vs ${s.noiseSd}`);
});
