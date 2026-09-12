import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The threshold the Track Record judges against.
 *
 * Kept as a test rather than only in the page, because "is 50% good" is the question
 * that decides whether every other number there means anything, and the answer is
 * counter-intuitive enough to be worth pinning: a coin flip loses money.
 */
const BREAK_EVEN = 110 / 210;
const coverRoi = (rate: number) => rate * (100 / 110) - (1 - rate);

test("a coin flip loses money at -110", () => {
  // The whole reason "vs coin flip" was the wrong comparison.
  assert.ok(coverRoi(0.5) < 0);
  assert.ok(Math.abs(coverRoi(0.5) + 0.04545) < 1e-4, `${coverRoi(0.5)}`);
});

test("break-even is 52.38%, not 50%", () => {
  assert.ok(Math.abs(BREAK_EVEN - 0.523809) < 1e-5);
  assert.ok(Math.abs(coverRoi(BREAK_EVEN)) < 1e-12, "break-even must return exactly zero");
});

test("the return is linear in the cover rate and crosses zero once", () => {
  assert.ok(coverRoi(0.52) < 0);
  assert.ok(coverRoi(0.53) > 0);
  // Every point of cover is worth about 1.9 cents.
  assert.ok(Math.abs((coverRoi(0.6) - coverRoi(0.59)) - 0.01909) < 1e-4);
});

test("the rates actually on the page price out as expected", () => {
  // 61.4% overall and 63.5% in the one bucket with enough games.
  assert.ok(Math.abs(coverRoi(0.614) - 0.1722) < 1e-3, `${coverRoi(0.614)}`);
  assert.ok(Math.abs(coverRoi(0.635) - 0.2123) < 1e-3, `${coverRoi(0.635)}`);
});
