/**
 * Corrections.
 *
 * The wrong side is the easiest mistake to make on the board -- the two sides are
 * adjacent buttons -- and the most expensive to leave standing, because the ledger then
 * reports a win where there was a loss and every rate drawn from it inherits that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mirrorSide } from "./correct.ts";

test("a spread carries its line to the other side", () => {
  assert.deepEqual(mirrorSide("spread", -3.5, "home", "away"), { side: "away", line: 3.5 });
  assert.deepEqual(mirrorSide("spread", 7, "away", "home"), { side: "home", line: -7 });
});

test("a total keeps its number, because both sides share it", () => {
  assert.deepEqual(mirrorSide("total", 45.5, "over", "under"), { side: "under", line: 45.5 });
});

test("a moneyline has no line to carry", () => {
  assert.deepEqual(mirrorSide("moneyline", null, "home", "away"), { side: "away", line: null });
});

test("choosing the side it already had changes nothing", () => {
  // Otherwise re-selecting the current side would flip the line under a bet that was
  // right all along -- a correction that introduces the error it exists to fix.
  assert.deepEqual(mirrorSide("spread", -3.5, "home", "home"), { side: "home", line: -3.5 });
});

test("a pick'em stays a pick'em", () => {
  assert.deepEqual(mirrorSide("spread", 0, "home", "away"), { side: "away", line: -0 });
});
