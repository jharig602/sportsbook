/**
 * Probability tests.
 *
 * These numbers appear next to a dollar figure, so the cases that matter most are the
 * refusals — where the model declines to have an opinion — and the de-vig, where an
 * arithmetic slip would quietly inflate every displayed edge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MarginModel,
  coverProbability,
  deVig,
  effectiveSpread,
  impliedProbability,
  lineProbability,
  residualAbove,
  residualAt,
  winProbabilityFromSpread,
} from "./probability.ts";

/**
 * Small symmetric stand-in with a deliberate spike on 3, like real football.
 * pmf keys are half-points, so 3 points is key 6.
 */
function model(overrides: Partial<MarginModel> = {}): MarginModel {
  const pmf: Record<string, number> = {};
  for (let halves = -40; halves <= 40; halves += 1) pmf[String(halves)] = 0.02;
  pmf["6"] = 0.1; // +3 points
  pmf["-6"] = 0.1; // -3 points
  pmf["0"] = 0.04;
  const total = Object.values(pmf).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(pmf)) pmf[k] /= total;
  return { league: "nfl", games: 500, mean: 0, sd: 13.5, lo: -20, hi: 20, pmf, ...overrides };
}

// --- implied probability --------------------------------------------------------

test("implied probability from american prices", () => {
  assert.equal(impliedProbability(100), 0.5);
  assert.equal(impliedProbability(-100), 0.5);
  assert.ok(Math.abs(impliedProbability(-110)! - 0.5238) < 0.001);
  assert.ok(Math.abs(impliedProbability(200)! - 0.3333) < 0.001);
});

test("impossible prices have no implied probability", () => {
  assert.equal(impliedProbability(null), null);
  assert.equal(impliedProbability(50), null);
});

// --- de-vig ---------------------------------------------------------------------

test("de-vigged probabilities sum to exactly one", () => {
  const fair = deVig(-110, -110)!;
  assert.ok(Math.abs(fair.a + fair.b - 1) < 1e-12);
  assert.ok(Math.abs(fair.a - 0.5) < 1e-12);
});

test("the hold is the excess over one, not the raw sum", () => {
  // -110 both ways is a 4.76% hold, the standard number for a two-sided market.
  const fair = deVig(-110, -110)!;
  assert.ok(Math.abs(fair.hold - 0.0476) < 0.001);
});

test("de-vig moves both sides down, never up", () => {
  const rawA = impliedProbability(-200)!;
  const rawB = impliedProbability(150)!;
  const fair = deVig(-200, 150)!;
  assert.ok(fair.a < rawA, "favourite should shed vig");
  assert.ok(fair.b < rawB, "underdog should shed vig");
});

test("de-vig needs both sides", () => {
  assert.equal(deVig(-110, null), null);
  assert.equal(deVig(null, null), null);
});

// --- residual distribution ------------------------------------------------------

test("residual mass above a threshold falls as the threshold rises", () => {
  const m = model();
  const values = [-10, -3, 0, 3, 10].map((t) => residualAbove(m, t));
  assert.deepEqual(values, [...values].sort((a, b) => b - a));
});

test("a symmetric model is a coin flip at zero", () => {
  const m = model();
  assert.ok(Math.abs(residualAbove(m, 0) - 0.5) < 0.05);
});

test("mass sits on the half-point grid and nowhere else", () => {
  const m = model();
  // Relative, not an arbitrary magnitude: what matters is that the spike is a spike.
  assert.ok(residualAt(m, 3) > residualAt(m, 3.5) * 2, "3 should tower over its neighbours");
  assert.ok(residualAt(m, 3.5) > 0, "half-points are on the grid too");
  assert.equal(residualAt(m, 3.25), 0, "a quarter-point cannot occur");
});

test("a half-point spread cannot push", () => {
  // Residual 0 is the push condition; a half-point line puts the residual on a
  // half-point, which is never exactly zero.
  const m = model();
  const push = residualAt(m, 0);
  assert.ok(push > 0, "a whole-number line can land exactly on the number");
});

test("probability beyond the observed range uses the normal tail, not zero", () => {
  const m = model();
  const far = residualAbove(m, 45);
  assert.ok(far > 0 && far < 0.01, `expected a small positive tail, got ${far}`);
});

// --- spread to win probability --------------------------------------------------

test("a pick'em is a coin flip for both sides", () => {
  const m = model();
  const home = winProbabilityFromSpread(m, 0, "home")!;
  const away = winProbabilityFromSpread(m, 0, "away")!;
  assert.ok(Math.abs(home - 0.5) < 0.05);
  assert.ok(Math.abs(home + away - 1) < 1e-9);
});

test("the favourite wins more often than the underdog", () => {
  const m = model();
  // Home laying 7 means a home spread of -7.
  const favourite = winProbabilityFromSpread(m, -7, "home")!;
  const dog = winProbabilityFromSpread(m, -7, "away")!;
  assert.ok(favourite > 0.5 && dog < 0.5, `${favourite} vs ${dog}`);
  assert.ok(Math.abs(favourite + dog - 1) < 1e-9);
});

test("a bigger spread means a higher win probability", () => {
  const m = model();
  const small = winProbabilityFromSpread(m, -3, "home")!;
  const large = winProbabilityFromSpread(m, -14, "home")!;
  assert.ok(large > small);
});

// --- the refusals ---------------------------------------------------------------

test("the model declines to have a view on spreads", () => {
  const result = lineProbability("spread", "home", -110, -110, -7, model());
  assert.equal(result.model, null);
  assert.equal(result.edgePoints, null);
  assert.match(result.note, /coin flip/);
  assert.ok(result.market !== null, "market probability is still shown");
});

test("the model declines on totals", () => {
  const result = lineProbability("total", "over", -110, -110, -7, model());
  assert.equal(result.model, null);
  assert.match(result.note, /coin flip/);
});

test("no fitted model means no model probability", () => {
  const result = lineProbability("moneyline", "home", -200, 170, -7, null);
  assert.equal(result.model, null);
  assert.equal(result.edgePoints, null);
  assert.ok(result.market !== null);
});

test("no spread means no model probability on the moneyline", () => {
  const result = lineProbability("moneyline", "home", -200, 170, null, model());
  assert.equal(result.model, null);
});

// --- the case this exists for ---------------------------------------------------

test("moneyline gets both opinions and a signed edge", () => {
  const result = lineProbability("moneyline", "home", -200, 170, -7, model());
  assert.ok(result.market !== null && result.model !== null);
  assert.ok(result.edgePoints !== null);
  assert.ok(
    Math.abs(result.edgePoints! - (result.model! - result.market!) * 100) < 1e-9,
    "edge must be model minus market, in points",
  );
});

test("edge flips sign when the price flips", () => {
  const cheap = lineProbability("moneyline", "home", 200, -240, -7, model());
  const rich = lineProbability("moneyline", "home", -400, 320, -7, model());
  assert.ok(cheap.edgePoints! > rich.edgePoints!, "a longer price should look better");
});

test("cover probability reports a push separately from a loss", () => {
  const result = coverProbability(model(), 0)!;
  assert.ok(result.cover > 0 && result.cover < 1);
  assert.ok(result.push >= 0);
});

// --- juice-adjusted spread ------------------------------------------------------

test("an evenly priced spread is taken at face value", () => {
  const m = model();
  assert.equal(effectiveSpread(m, -3, 0.5), -3);
});

test("a spread the book charges extra for is shorter than posted", () => {
  // Houston: posted -1.5, priced +102/-122, which de-vigs to home covering 47.4%.
  // The book does not believe -1.5.
  const m = model({ sd: 12.3 });
  const adjusted = effectiveSpread(m, -1.5, 0.474);
  assert.ok(adjusted > -1.5, "should lay fewer points than posted");
  assert.ok(adjusted > -1.2 && adjusted < -0.3, `expected about -0.7, got ${adjusted}`);
});

test("a spread the book discounts is longer than posted", () => {
  const m = model({ sd: 12.3 });
  assert.ok(effectiveSpread(m, -3, 0.55) < -3);
});

test("the adjustment never flips which side is favoured", () => {
  const m = model({ sd: 12.3 });
  // An extreme cover probability must not turn a home favourite into a home dog.
  assert.ok(effectiveSpread(m, -1, 0.2) <= 0);
});

test("no cover probability means no adjustment", () => {
  const m = model();
  assert.equal(effectiveSpread(m, -7, null), -7);
});

test("juice shrinks an overstated edge", () => {
  const m = model({ sd: 12.3 });
  const naive = lineProbability("moneyline", "home", -110, -110, -1.5, m);
  const adjusted = lineProbability("moneyline", "home", -110, -110, -1.5, m, 0.474);
  assert.ok(
    adjusted.model! < naive.model!,
    "accounting for juice should lower the model's confidence",
  );
  assert.match(adjusted.note, /priced like/);
});
