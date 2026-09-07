/**
 * Stake sizing tests. Run with `npm test`.
 *
 * This is the only code in the project that produces a dollar figure someone might act
 * on, so the cases that matter most are the refusals: no edge means no Kelly, and an
 * uncalibrated bucket means flat, never a guess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SETTINGS,
  americanToDecimal,
  fullKellyFraction,
  recommendStake,
  type StakeSettings,
} from "./staking.ts";

const settings: StakeSettings = { ...DEFAULT_SETTINGS, bankroll: 1000 };

// --- odds conversion -----------------------------------------------------------

test("american to decimal", () => {
  assert.equal(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(-100), 2);
  assert.equal(americanToDecimal(200), 3);
  assert.equal(americanToDecimal(-200), 1.5);
  assert.ok(Math.abs(americanToDecimal(-110)! - 1.909090909) < 1e-6);
});

test("impossible prices convert to null", () => {
  assert.equal(americanToDecimal(null), null);
  assert.equal(americanToDecimal(50), null);
  assert.equal(americanToDecimal(0), null);
});

// --- Kelly ---------------------------------------------------------------------

test("kelly is null when there is no edge", () => {
  // At -110 the break-even win rate is about 52.4%. A 50% shot is a losing bet.
  assert.equal(fullKellyFraction(0.5, -110), null);
  assert.equal(fullKellyFraction(0.52, -110), null);
});

test("kelly is positive once the edge is real", () => {
  const fraction = fullKellyFraction(0.6, -110)!;
  assert.ok(fraction > 0 && fraction < 1);
});

test("kelly matches the closed form at even money", () => {
  // At +100, f = 2p - 1. A 60% shot gives 20%.
  assert.ok(Math.abs(fullKellyFraction(0.6, 100)! - 0.2) < 1e-9);
});

test("kelly grows with the edge", () => {
  const small = fullKellyFraction(0.55, 100)!;
  const large = fullKellyFraction(0.75, 100)!;
  assert.ok(large > small);
});

test("kelly rejects impossible probabilities", () => {
  assert.equal(fullKellyFraction(0, 100), null);
  assert.equal(fullKellyFraction(1, 100), null);
  assert.equal(fullKellyFraction(1.5, 100), null);
  assert.equal(fullKellyFraction(0.6, null), null);
});

// --- the refusal that matters ---------------------------------------------------

test("an uncalibrated bucket always gets a flat stake", () => {
  const advice = recommendStake(settings, -110, null);
  assert.equal(advice.basis, "flat");
  assert.equal(advice.amount, 10); // 1% of 1000
  assert.equal(advice.units, 1);
  assert.match(advice.reason, /not been graded on enough finished games/);
});

test("a calibrated but losing probability still gets a flat stake", () => {
  // 51% at -110 is calibrated, and still not good enough to bet more on.
  const advice = recommendStake(settings, -110, 0.51);
  assert.equal(advice.basis, "flat");
  assert.match(advice.reason, /does not clear the price offered/);
});

test("strength alone never changes the stake", () => {
  // Two alerts, wildly different Move Strength, neither calibrated: same money.
  const weak = recommendStake(settings, -110, null);
  const strong = recommendStake(settings, -110, null);
  assert.equal(weak.amount, strong.amount);
});

// --- kelly path ----------------------------------------------------------------

test("a calibrated edge switches to fractional kelly", () => {
  const advice = recommendStake(settings, -110, 0.62);
  assert.equal(advice.basis, "kelly");
  assert.ok(advice.amount! > 10, "an edge should stake more than one flat unit");
  assert.match(advice.reason, /Kelly/);
});

test("kelly stake is a quarter of full kelly", () => {
  const full = fullKellyFraction(0.62, -110)!;
  const advice = recommendStake({ ...settings, maxFraction: 1 }, -110, 0.62);
  assert.ok(Math.abs(advice.amount! - 1000 * full * 0.25) < 0.01);
});

// --- caps ----------------------------------------------------------------------

test("the hard cap binds even on a huge apparent edge", () => {
  const advice = recommendStake(settings, 200, 0.95);
  assert.equal(advice.cappedByMax, true);
  assert.equal(advice.amount, 30); // 3% of 1000
  assert.match(advice.reason, /Capped at/);
});

test("a flat stake above the cap is also clamped", () => {
  const reckless = { ...settings, unitFraction: 0.1, maxFraction: 0.03 };
  const advice = recommendStake(reckless, -110, null);
  assert.equal(advice.cappedByMax, true);
  assert.equal(advice.amount, 30);
});

// --- no bankroll ---------------------------------------------------------------

test("no bankroll means no dollar figure, but still a unit count", () => {
  const advice = recommendStake({ ...settings, bankroll: 0 }, -110, null);
  assert.equal(advice.amount, null);
  assert.equal(advice.units, 1);
});

test("amounts are rounded to cents", () => {
  const advice = recommendStake({ ...settings, bankroll: 333.33 }, -110, null);
  assert.equal(advice.amount, Math.round(advice.amount! * 100) / 100);
});
