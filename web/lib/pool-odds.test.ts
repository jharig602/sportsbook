import assert from "node:assert/strict";
import { test } from "node:test";

import { aliveCurve, extraLifeMultiple, poolOdds, survival } from "./pool-odds.ts";

const near = (a: number, b: number, msg?: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);

// --- survival with a loss allowance ------------------------------------------------

test("with no lives spare, survival is just the product", () => {
  near(survival([0.8, 0.75, 0.9], 0), 0.8 * 0.75 * 0.9);
});

test("one spare life: at most one loss across the season", () => {
  // P(0 losses) + P(exactly 1 loss), by hand.
  const p = [0.8, 0.75];
  const expected = 0.8 * 0.75 + 0.2 * 0.75 + 0.8 * 0.25;
  near(survival(p, 1), expected);
});

test("a spare life is worth a great deal over a long season", () => {
  // The reason a two-strike pool cannot be planned with a one-strike number: over
  // eighteen weeks at 78% a week, the product is a rounding error and the real figure
  // is an order of magnitude larger.
  const season = new Array(18).fill(0.78);
  const one = survival(season, 0);
  const two = survival(season, 1);
  assert.ok(two > one * 5, `spare life multiple was only ${(two / one).toFixed(1)}x`);
  assert.ok(Math.abs(extraLifeMultiple(season) - two / one) < 1e-12);
});

test("more lives never hurts", () => {
  const p = [0.7, 0.8, 0.6, 0.9];
  assert.ok(survival(p, 1) > survival(p, 0));
  assert.ok(survival(p, 2) > survival(p, 1));
});

test("certain wins survive any allowance", () => {
  near(survival([1, 1, 1], 0), 1);
  near(survival([1, 1, 1], 1), 1);
});

test("with one life, two certain losses are fatal", () => {
  near(survival([0, 0], 1), 0);
  near(survival([0, 1], 1), 1, "a single loss is survivable");
});

test("an empty plan is not an elimination", () => {
  near(survival([], 1), 1);
  assert.deepEqual(aliveCurve([], 1), []);
});

test("the curve reports P(alive) week by week, not just at the end", () => {
  const curve = aliveCurve([0.8, 0.75], 0);
  near(curve[0], 0.8);
  near(curve[1], 0.6);
  assert.equal(curve.length, 2);
});

test("the curve is monotone: you cannot come back from elimination", () => {
  const curve = aliveCurve([0.9, 0.5, 0.7, 0.95], 1);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] <= curve[i - 1] + 1e-12);
  }
});

// --- the field --------------------------------------------------------------------

test("a spare life keeps a small pool alive to the very end", () => {
  // I expected 13 players to be gone by week 6. With a second life at 78% a week they
  // are not: 0.8 rivals remain at week 18, so the pool runs the full season and is
  // decided by a tiebreaker as often as by elimination.
  const season = new Array(18).fill(0.78);
  const small = poolOdds(season, 1, 13);
  assert.equal(small.likelyEndWeek, 18);
  assert.ok(small.fieldAlive[16] > 1, "still more than one rival entering the last week");
});

test("a big two-life pool does not resolve inside the season at all", () => {
  // The finding that changes the strategy. 137 entrants with a spare life each leave
  // about nine still standing after week 18 -- surviving is not going to win it, so
  // the prize goes to whoever separated from the field, not whoever played safest.
  const season = new Array(18).fill(0.78);
  const big = poolOdds(season, 1, 137);
  assert.equal(big.likelyEndWeek, null, "nobody is the last one standing");
  assert.ok(big.fieldAlive[17] > 5, `${big.fieldAlive[17].toFixed(1)} rivals left at the end`);
});

test("the same survival is worth less in a crowded pool", () => {
  // The core of the pool-size argument: identical play, different prize.
  const season = new Array(18).fill(0.78);
  const small = poolOdds(season, 1, 13);
  const big = poolOdds(season, 1, 137);
  assert.equal(small.survival, big.survival, "the plan is the same plan");
  assert.ok(small.winChance > big.winChance, "but it wins the small pool more often");
});

test("a pool of one is already won", () => {
  const odds = poolOdds([0.8, 0.8], 1, 1);
  assert.equal(odds.fieldAlive[0], 0);
  assert.equal(odds.likelyEndWeek, 1);
  near(odds.winChance, odds.alive[0]);
});

test("the field is counted excluding you", () => {
  const odds = poolOdds([1], 0, 10);
  assert.equal(odds.fieldAlive[0], 9, "nine rivals, not ten");
});

test("differentiation becomes relevant once the field has halved", () => {
  const season = new Array(18).fill(0.78);
  const big = poolOdds(season, 1, 137);
  const small = poolOdds(season, 1, 13);
  // Halving depends only on the survival curve, so it lands in the same week whatever
  // the size -- what differs is how many people are still there when it does.
  assert.equal(big.differentiationWeek, small.differentiationWeek);
  assert.ok(big.fieldAlive[big.differentiationWeek! - 1] > 50,
    "in a big pool, half the field is still a crowd");
});

test("a plan that never thins the field reports no end week", () => {
  const odds = poolOdds([1, 1, 1], 1, 137);
  assert.equal(odds.likelyEndWeek, null, "nobody ever loses, so nobody is eliminated");
});
