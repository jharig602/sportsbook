/**
 * Joint score tests.
 *
 * The claim this module makes is that multiplying legs is wrong, so most of these check
 * the *direction and size* of the gap against the product rather than against a stored
 * number. A sign error here would recommend exactly the parlays a book most wants to
 * take, and it would look perfectly reasonable on screen.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GameLines,
  type ScoreLeg,
  type ScoreModel,
  constraintFor,
  independentProduct,
  jointProbability,
  marginGrid,
} from "./joint-score.ts";
import { type MarginModel, normalCdf, residualAbove } from "./probability.ts";

/** The same shape as the probability tests use: symmetric, with a spike on 3. */
function margin(overrides: Partial<MarginModel> = {}): MarginModel {
  const pmf: Record<string, number> = {};
  for (let halves = -40; halves <= 40; halves += 1) pmf[String(halves)] = 0.02;
  pmf["6"] = 0.1;
  pmf["-6"] = 0.1;
  pmf["0"] = 0.04;
  const total = Object.values(pmf).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(pmf)) pmf[k] /= total;
  return { league: "nfl", games: 500, mean: 0, sd: 13.5, lo: -20, hi: 20, pmf, ...overrides };
}

/** The NFL figures actually fitted on seven seasons. */
function score(overrides: Partial<ScoreModel> = {}): ScoreModel {
  return {
    league: "nfl",
    games: 2020,
    totalMean: 0.5832,
    totalSd: 12.8785,
    marginMean: -0.3881,
    marginSd: 12.7001,
    correlation: 0.00169,
    ...overrides,
  };
}

const LINES: GameLines = { homeSpread: -3.5, total: 45.5 };

// --- the grid -------------------------------------------------------------------

test("the grid is a complete distribution", () => {
  const grid = marginGrid(margin());
  const mass = grid.reduce((sum, point) => sum + point.mass, 0);
  assert.ok(Math.abs(mass - 1) < 1e-12, `mass ${mass}`);
  assert.ok(grid.every((point) => point.mass > 0));
});

test("the grid reaches past the fitted range, where the pmf stops", () => {
  const grid = marginGrid(margin());
  // A 40-point residual was never observed in this fixture, but it is not impossible.
  assert.ok(grid.some((point) => point.m > 20));
  assert.ok(grid.some((point) => point.m < -20));
});

test("the grid agrees with residualAbove rather than merely resembling it", () => {
  const model = margin();
  const grid = marginGrid(model);
  for (const threshold of [-7, -3.5, 0, 2.5, 10, 21]) {
    const fromGrid = grid
      .filter((point) => point.m > threshold)
      .reduce((sum, point) => sum + point.mass, 0);
    assert.ok(
      Math.abs(fromGrid - residualAbove(model, threshold)) < 1e-9,
      `at ${threshold}: ${fromGrid} vs ${residualAbove(model, threshold)}`,
    );
  }
});

// --- single legs ----------------------------------------------------------------

test("one spread leg is the margin model and nothing more", () => {
  const model = margin();
  const leg: ScoreLeg = { market: "spread", side: "home", line: -3.5 };
  const joint = jointProbability(model, score(), LINES, [leg])!;
  // Priced at -3.5 and betting -3.5, the side covers exactly when the residual is
  // positive. Anything else here would mean the two halves disagree about what a
  // residual is.
  assert.ok(Math.abs(joint.win - residualAbove(model, 0)) < 1e-9);
});

test("one total leg is the fitted normal", () => {
  const joint = jointProbability(margin(), score(), LINES, [
    { market: "total", side: "over", line: 45.5 },
  ])!;
  const expected = 1 - normalCdf((0 - 0.5832) / 12.8785);
  assert.ok(Math.abs(joint.win - expected) < 1e-9, `${joint.win} vs ${expected}`);
  // Worth stating out loud: games land slightly over the closing number, and it is
  // nowhere near enough. 52.38% is what -110 asks for.
  assert.ok(joint.win > 0.51 && joint.win < 0.522);
});

test("an alternate line needs no special handling", () => {
  const model = margin();
  // Priced at -3.5, buying the alt at -7: the margin must clear 7, i.e. the residual
  // must clear 3.5.
  const joint = jointProbability(model, score(), LINES, [
    { market: "spread", side: "home", line: -7 },
  ])!;
  assert.ok(Math.abs(joint.win - residualAbove(model, 3.5)) < 1e-9);
});

// --- the whole point ------------------------------------------------------------

test("independent legs multiply, because at this correlation they nearly do", () => {
  const flat = score({ correlation: 0 });
  const legs: ScoreLeg[] = [
    { market: "spread", side: "home", line: -3.5 },
    { market: "total", side: "over", line: 45.5 },
  ];
  const joint = jointProbability(margin(), flat, LINES, legs)!;
  const product = independentProduct(margin(), flat, LINES, legs)!;
  assert.ok(Math.abs(joint.win - product) < 1e-12, `${joint.win} vs ${product}`);
});

test("a team total and the side that scores it are related even with no correlation", () => {
  // This is the case the whole file exists for. The margin and the total can be
  // perfectly independent and a home win still makes home points likelier, because home
  // points are (total + margin) / 2 -- they are the same two numbers read twice.
  const flat = score({ correlation: 0 });
  const legs: ScoreLeg[] = [
    { market: "moneyline", side: "home" },
    { market: "team_total", team: "home", side: "over", line: 24.5 },
  ];
  const joint = jointProbability(margin(), flat, LINES, legs)!;
  const product = independentProduct(margin(), flat, LINES, legs)!;
  assert.ok(joint.win > product, `${joint.win} should beat ${product}`);
  // And by a wide margin, not a rounding difference -- this is worth real money.
  assert.ok(joint.win / product > 1.15, `ratio ${joint.win / product}`);
});

test("the opponent's team total runs the other way", () => {
  const flat = score({ correlation: 0 });
  const legs: ScoreLeg[] = [
    { market: "moneyline", side: "home" },
    { market: "team_total", team: "away", side: "over", line: 24.5 },
  ];
  const joint = jointProbability(margin(), flat, LINES, legs)!;
  const product = independentProduct(margin(), flat, LINES, legs)!;
  assert.ok(joint.win < product, `${joint.win} should fall short of ${product}`);
});

test("a positive correlation pulls the favourite and the over together", () => {
  const legs: ScoreLeg[] = [
    { market: "spread", side: "home", line: -3.5 },
    { market: "total", side: "over", line: 45.5 },
  ];
  const flat = jointProbability(margin(), score({ correlation: 0 }), LINES, legs)!;
  const college = jointProbability(margin(), score({ correlation: 0.0946 }), LINES, legs)!;
  assert.ok(college.win > flat.win, `${college.win} vs ${flat.win}`);
  // Small, because the measured correlation is small. A model claiming otherwise would
  // be claiming something these seven seasons did not show.
  assert.ok(college.win - flat.win < 0.02);
});

test("a spread and the moneyline behind it barely differ", () => {
  // Laying -3.5 and taking the same side outright is close to one bet, not two: the
  // moneyline is implied by the cover almost all of the time.
  const legs: ScoreLeg[] = [
    { market: "spread", side: "home", line: -3.5 },
    { market: "moneyline", side: "home" },
  ];
  const joint = jointProbability(margin(), score(), LINES, legs)!;
  const cover = jointProbability(margin(), score(), LINES, [legs[0]])!;
  // Covering -3.5 means winning by 4 or more, which already implies the win outright.
  assert.ok(Math.abs(joint.win - cover.win) < 1e-9);
});

test("legs that contradict each other are impossible, not merely unlikely", () => {
  const over: ScoreLeg = { market: "total", side: "over", line: 45.5 };
  const under: ScoreLeg = { market: "total", side: "under", line: 45.5 };
  assert.equal(jointProbability(margin(), score(), LINES, [over, under])!.win, 0);

  const home: ScoreLeg = { market: "moneyline", side: "home" };
  const away: ScoreLeg = { market: "moneyline", side: "away" };
  assert.equal(jointProbability(margin(), score(), LINES, [home, away])!.win, 0);
});

// --- pushes ---------------------------------------------------------------------

test("a whole number can push and a half-point cannot", () => {
  const whole = jointProbability(margin(), score(), { homeSpread: -3, total: 45.5 }, [
    { market: "spread", side: "home", line: -3 },
  ])!;
  assert.ok(whole.pushPossible);
  assert.ok(whole.push > 0, `push ${whole.push}`);
  assert.ok(Math.abs(whole.win + whole.push + whole.loss - 1) < 1e-9);

  const half = jointProbability(margin(), score(), LINES, [
    { market: "spread", side: "home", line: -3.5 },
  ])!;
  assert.equal(half.pushPossible, false);
  assert.equal(half.push, 0);
});

test("a tie pushes the moneyline", () => {
  const joint = jointProbability(margin(), score(), { homeSpread: -3, total: 45.5 }, [
    { market: "moneyline", side: "home" },
  ])!;
  assert.ok(joint.push > 0, "an NFL game can end level");
});

// --- refusals -------------------------------------------------------------------

test("no legs, no number", () => {
  assert.equal(jointProbability(margin(), score(), LINES, []), null);
});

test("a model with no spread is refused rather than treated as certainty", () => {
  assert.equal(jointProbability(margin(), score({ totalSd: 0 }), LINES, []), null);
  assert.equal(
    jointProbability(margin(), score({ totalSd: 0 }), LINES, [
      { market: "total", side: "over", line: 45.5 },
    ]),
    null,
  );
});

test("a game with no priced lines is refused", () => {
  const legs: ScoreLeg[] = [{ market: "moneyline", side: "home" }];
  assert.equal(jointProbability(margin(), score(), { homeSpread: NaN, total: 45.5 }, legs), null);
});

// --- the half-plane algebra -----------------------------------------------------

test("each market becomes the half-plane it should", () => {
  assert.deepEqual(constraintFor({ market: "spread", side: "home", line: -3.5 }), {
    aD: 1,
    aS: 0,
    c: 3.5,
  });
  assert.deepEqual(constraintFor({ market: "spread", side: "away", line: 3.5 }), {
    aD: -1,
    aS: 0,
    c: -3.5,
  });
  assert.deepEqual(constraintFor({ market: "total", side: "under", line: 45.5 }), {
    aD: 0,
    aS: -1,
    c: -45.5,
  });
  // Home over 24.5 is (S + D) / 2 > 24.5, doubled.
  assert.deepEqual(
    constraintFor({ market: "team_total", team: "home", side: "over", line: 24.5 }),
    { aD: 1, aS: 1, c: 49 },
  );
  // Away over 24.5 is (S - D) / 2 > 24.5.
  assert.deepEqual(
    constraintFor({ market: "team_total", team: "away", side: "over", line: 24.5 }),
    { aD: -1, aS: 1, c: 49 },
  );
});
