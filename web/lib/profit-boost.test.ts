import assert from "node:assert/strict";
import { test } from "node:test";

import { boostedEv, boostedPrice, parlayPrice, profitPerDollar } from "./profit-boost.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

test("profit per dollar at both signs", () => {
  assert.equal(profitPerDollar(300), 3);
  assert.ok(close(profitPerDollar(-150), 2 / 3));
  assert.ok(Number.isNaN(profitPerDollar(50)), "not an American price");
});

test("a boosted price doubles the profit, on both sides of even money", () => {
  assert.equal(boostedPrice(300), 600);
  assert.equal(boostedPrice(-150), 133);
  assert.equal(boostedPrice(-300), -150);
  assert.equal(boostedPrice(100), 200);
});

test("with no boost, value is the ordinary expected return", () => {
  // A fair coin at +100 is worth exactly nothing.
  assert.ok(close(boostedEv(0.5, 100, 0), 0));
  // At -110 it loses the vig: 0.5 x 1.909 - 1.
  assert.ok(close(boostedEv(0.5, -110, 0), 0.5 * (1 + 100 / 110) - 1));
});

test("a 100% boost on a fair price is worth one minus the win probability", () => {
  // p x (1 + 2b) - 1 with p = 1/(1+b) is b/(1+b) = 1 - p: the longer the odds, the
  // more the boost is worth, up to the whole stake. The margin is what caps it.
  for (const price of [100, 200, 400, 900]) {
    const p = 1 / (1 + profitPerDollar(price));
    assert.ok(close(boostedEv(p, price), 1 - p), String(price));
  }
});

test("the margin costs twice as much once the payout is doubled", () => {
  // Same +400 price, true probability 5% lower than implied: the plain bet loses 5%,
  // the boosted one gives up about 10% relative to the fair case.
  const q = 0.2;
  const fair = boostedEv(q, 400);
  const held = boostedEv(q * 0.95, 400);
  assert.ok(close(fair - held, q * 0.05 * 9), `${fair - held}`);
  assert.ok(close(boostedEv(q, 400, 0) - boostedEv(q * 0.95, 400, 0), q * 0.05 * 5));
});

test("a certain loser is worth minus the stake, boosted or not", () => {
  assert.equal(boostedEv(0, 500), -1);
});

test("a parlay is priced as the product of its legs, rounded against you", () => {
  // Two -110 legs: 1.909^2 = 3.6446, so +264 after rounding down.
  assert.equal(parlayPrice([-110, -110]), 264);
  assert.equal(parlayPrice([100, 100]), 300);
});

test("nonsense in is NaN out, never a plausible number", () => {
  assert.ok(Number.isNaN(boostedEv(1.2, 300)));
  assert.ok(Number.isNaN(boostedPrice(20)));
});
