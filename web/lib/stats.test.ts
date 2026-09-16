import assert from "node:assert/strict";
import { test } from "node:test";

import { binomialTailAtLeast, probit, upperTail } from "./stats.ts";

test("probit inverts the normal at the values everyone knows", () => {
  assert.ok(Math.abs(probit(0.975) - 1.959964) < 1e-5, "the 95% two-sided z");
  assert.ok(Math.abs(probit(0.5)) < 1e-9);
  assert.ok(Math.abs(probit(0.95) - 1.644854) < 1e-5);
  assert.ok(Math.abs(probit(0.99) - 2.326348) < 1e-5);
  // Symmetric, and the tails the multiple-comparison correction actually reaches.
  assert.ok(Math.abs(probit(0.025) + 1.959964) < 1e-5);
  assert.ok(Math.abs(probit(1 - 0.05 / 12) - 2.638257) < 1e-4, "six two-sided tests");
});

test("probit refuses what is not a probability", () => {
  for (const bad of [0, 1, -0.1, 1.1, Number.NaN]) {
    assert.ok(Number.isNaN(probit(bad)), String(bad));
  }
});

test("the binomial tail matches hand arithmetic", () => {
  // Three coins, at least two heads: 3/8 + 1/8 = 0.5.
  assert.ok(Math.abs(binomialTailAtLeast(2, 3, 0.5) - 0.5) < 1e-12);
  // All ten heads.
  assert.ok(Math.abs(binomialTailAtLeast(10, 10, 0.5) - Math.pow(0.5, 10)) < 1e-12);
  // At least one of anything is the complement of none.
  assert.ok(Math.abs(binomialTailAtLeast(1, 5, 0.3) - (1 - Math.pow(0.7, 5))) < 1e-12);
});

test("the binomial tail is bounded and sane at the edges", () => {
  assert.equal(binomialTailAtLeast(0, 20, 0.5), 1, "at least zero always happens");
  assert.equal(binomialTailAtLeast(21, 20, 0.5), 0, "more than n never does");
  assert.equal(binomialTailAtLeast(5, 0, 0.5), 1);
  const p = binomialTailAtLeast(60, 100, 0.5238);
  assert.ok(p > 0 && p < 1);
});

test("it stays accurate where the normal approximation is worst", () => {
  // Seventeen games -- the size a six-cell breakdown of this record produces, and the
  // reason the tail is computed exactly rather than approximated.
  const exact = binomialTailAtLeast(12, 17, 110 / 210);
  // Direct sum, no log-gamma, as an independent check.
  let brute = 0;
  const choose = (n: number, k: number) => {
    let out = 1;
    for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
    return out;
  };
  for (let k = 12; k <= 17; k += 1) {
    brute += choose(17, k) * Math.pow(110 / 210, k) * Math.pow(100 / 210, 17 - k);
  }
  assert.ok(Math.abs(exact - brute) < 1e-10, `${exact} vs ${brute}`);
});

test("a 12-of-17 cell is not the finding it looks like", () => {
  // 70.6% against a 52.4% break-even, and it happens better than one time in eight
  // from a rule with no edge at all -- before accounting for having picked it out of six.
  const p = binomialTailAtLeast(12, 17, 110 / 210);
  assert.ok(p > 0.1 && p < 0.16, `p=${p}`);
});

test("the normal tail matches the values everyone knows", () => {
  assert.ok(Math.abs(upperTail(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(upperTail(1.959964) - 0.025) < 1e-6);
  assert.ok(Math.abs(upperTail(-1.644854) - 0.95) < 1e-6);
  assert.ok(Math.abs(upperTail(3) - 0.0013499) < 1e-6);
});

test("the normal tail and probit invert each other", () => {
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.8, 0.99]) {
    assert.ok(Math.abs(upperTail(probit(1 - p)) - p) < 2e-7, String(p));
  }
});
