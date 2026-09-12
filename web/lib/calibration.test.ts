import assert from "node:assert/strict";
import { test } from "node:test";

import { calibrate, type Calibrated } from "./calibration.ts";

function pick(fair: number, covered: boolean | null): Calibrated {
  return { market: "spread", league: "nfl", fair_probability: fair, result_covered: covered };
}

/** n picks at probability `fair`, of which `hits` came in. */
function many(fair: number, hits: number, misses: number): Calibrated[] {
  return [
    ...Array.from({ length: hits }, () => pick(fair, true)),
    ...Array.from({ length: misses }, () => pick(fair, false)),
  ];
}

test("nothing graded yields nulls, not zeros", () => {
  const c = calibrate([]);
  assert.equal(c.n, 0);
  assert.equal(c.predicted, null);
  assert.equal(c.actual, null);
  // A Brier of 0 is a perfect score. Reporting one for an empty sample would read as
  // the model being flawless rather than untested.
  assert.equal(c.brier, null);
  for (const band of c.bands) assert.equal(band.verdict, null);
});

test("pushes leave entirely -- a push is not a wrong probability", () => {
  const c = calibrate([pick(0.6, true), pick(0.6, false), pick(0.6, null)]);
  assert.equal(c.n, 2);
  assert.equal(c.actual, 0.5);
});

test("an honest rule shows no gap", () => {
  // 60 picks called at 60%, 36 of which landed.
  const c = calibrate(many(0.6, 36, 24));
  const band = c.bands.find((b) => b.lo === 0.55)!;
  assert.equal(band.n, 60);
  assert.ok(Math.abs(band.predicted! - 0.6) < 1e-9);
  assert.ok(Math.abs(band.actual! - 0.6) < 1e-9);
  assert.ok(Math.abs(band.gap!) < 1e-9);
  assert.equal(band.verdict!.state, "undecided", "no evidence against its own claim");
});

test("overconfidence shows as a negative gap in the upper bands", () => {
  // Called 60%, delivered 45% over a big sample. The failure a consensus model makes.
  const c = calibrate(many(0.6, 90, 110));
  const band = c.bands.find((b) => b.lo === 0.55)!;
  assert.ok(band.gap! < -0.1, `gap=${band.gap}`);
  assert.equal(band.verdict!.state, "fails", "the band misses its OWN prediction");
});

test("a band is judged against what it predicted, not against break-even", () => {
  // Predicted 42% and delivered 42%: perfectly honest, and still a losing bet at -110.
  // Conflating the two is how a working model gets thrown away for being unprofitable.
  const c = calibrate(many(0.42, 42, 58));
  const band = c.bands.find((b) => b.lo === 0)!;
  assert.ok(Math.abs(band.gap!) < 1e-9);
  assert.equal(band.verdict!.state, "undecided", "honest about a bad bet is still honest");
});

test("bands split on their own boundaries without overlapping", () => {
  const c = calibrate([pick(0.45, true), pick(0.55, true), pick(0.65, true), pick(1, true)]);
  assert.deepEqual(c.bands.map((b) => b.n), [0, 1, 1, 2]);
  assert.equal(c.n, 4, "every pick lands in exactly one band");
});

test("Brier punishes confident nonsense and rewards nothing for hedging", () => {
  // Confident and wrong: worse than a coin flip on the same games.
  const confidentlyWrong = calibrate(many(0.9, 10, 90));
  assert.ok(confidentlyWrong.brier! > confidentlyWrong.brierBaseline!);

  // Confident and right: better.
  const confidentlyRight = calibrate(many(0.9, 90, 10));
  assert.ok(confidentlyRight.brier! < confidentlyRight.brierBaseline!);

  // Saying 50% about everything is perfectly calibrated and completely useless, and
  // only the Brier notices -- it ties the baseline exactly.
  const useless = calibrate(many(0.5, 50, 50));
  assert.ok(Math.abs(useless.brier! - useless.brierBaseline!) < 1e-9);
  assert.ok(Math.abs(useless.bands.find((b) => b.lo === 0.45)!.gap!) < 1e-9,
    "and the calibration table calls it flawless");
});

test("the headline means are over every graded pick, bands included", () => {
  const c = calibrate([...many(0.4, 4, 6), ...many(0.7, 7, 3)]);
  assert.equal(c.n, 20);
  assert.ok(Math.abs(c.predicted! - 0.55) < 1e-9);
  assert.ok(Math.abs(c.actual! - 0.55) < 1e-9);
});
