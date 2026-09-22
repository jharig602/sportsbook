/**
 * Calibration tests.
 *
 * The slope decides how much of a measured edge the app is allowed to believe, so the
 * cases that matter are the ones where it would be wrong in the flattering direction:
 * a perfect rule reading as broken, a worthless rule reading as usable, or nine books on
 * one number counting as nine facts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CensusRow,
  type GradedCensus,
  calibrate,
  calibratedEdgePoints,
  collapseCensus,
  gradeCensus,
} from "./edge-calibration.ts";
import type { Score } from "./settle.ts";

function row(over: Partial<CensusRow> = {}): CensusRow {
  return {
    census_id: Math.random().toString(36).slice(2),
    league: "nfl",
    event_id: "E1",
    book: "FanDuel",
    market: "spread",
    side: "home",
    line: -3.5,
    price: -110,
    fair_probability: 0.5238,
    break_even: 0.5238,
    edge_points: 0,
    books_compared: 5,
    thin_consensus: false,
    ...over,
  };
}

function graded(predictedEdge: number, covered: boolean | null, over: Partial<GradedCensus> = {}): GradedCensus {
  const breakEven = 0.5238;
  return {
    ...row({ break_even: breakEven, fair_probability: breakEven + predictedEdge / 100 }),
    edge_points: predictedEdge,
    covered,
    ...over,
  };
}

/** n rows at one predicted edge, of which `winRate` actually covered. */
function sample(predictedEdge: number, n: number, winRate: number): GradedCensus[] {
  const wins = Math.round(n * winRate);
  return Array.from({ length: n }, (_, i) =>
    graded(predictedEdge, i < wins, { event_id: `E${predictedEdge}-${i}` }),
  );
}

// --- the slope -------------------------------------------------------------------

test("a rule that delivers exactly what it claims reads as slope one", () => {
  // Predicted +4 points, realised 52.38% + 4% = 56.38%.
  const rows = [
    ...sample(4, 2000, 0.5638),
    ...sample(-4, 2000, 0.4838),
  ];
  const fit = calibrate(rows);
  assert.ok(Math.abs(fit.slope! - 1) < 0.05, `slope ${fit.slope}`);
});

test("a rule delivering half its claim reads as slope one half", () => {
  // The case worth catching: directionally right, twice as loud as it should be.
  const rows = [
    ...sample(4, 2000, 0.5438),
    ...sample(-4, 2000, 0.5038),
  ];
  const fit = calibrate(rows);
  assert.ok(Math.abs(fit.slope! - 0.5) < 0.05, `slope ${fit.slope}`);
});

test("a rule that predicts nothing reads as slope zero", () => {
  // Every band covers at break-even regardless of what was claimed.
  const rows = [
    ...sample(4, 2000, 0.5238),
    ...sample(-4, 2000, 0.5238),
  ];
  const fit = calibrate(rows);
  assert.ok(Math.abs(fit.slope!) < 0.05, `slope ${fit.slope}`);
});

test("the error bar shrinks with the sample, not with the number of books", () => {
  const small = calibrate(sample(4, 100, 0.56));
  const large = calibrate(sample(4, 10_000, 0.56));
  assert.ok(large.slopeSe! < small.slopeSe!);
  // Ten thousand rows is a hundred times one hundred, so the error should fall tenfold.
  assert.ok(Math.abs(small.slopeSe! / large.slopeSe! - 10) < 1);
});

test("pushes leave the denominator rather than counting as half", () => {
  const rows = [...sample(4, 10, 1), graded(4, null)];
  const fit = calibrate(rows);
  assert.equal(fit.n, 10);
  assert.equal(fit.buckets.find((b) => b.lo === 3)?.pushes, 1);
});

// --- one result per number -------------------------------------------------------

test("nine books on one number are one fact", () => {
  // Counting them nine times would shrink every interval threefold around a sample that
  // never grew.
  const books = ["FanDuel", "BetMGM", "DraftKings", "Caesars", "BetRivers"];
  const rows = books.map((book) =>
    graded(3, true, { book, event_id: "E1", market: "spread", side: "home", line: -3.5 }),
  );
  assert.equal(collapseCensus(rows).length, 1);
});

test("different numbers on one game stay different facts", () => {
  const rows = [
    graded(3, true, { book: "A", line: -3.5 }),
    graded(3, true, { book: "B", line: -3 }),
    graded(3, true, { book: "C", market: "total", side: "over", line: 45.5 }),
  ];
  assert.equal(collapseCensus(rows).length, 3);
});

test("the best price survives the collapse, because that is the bet available", () => {
  const rows = [
    graded(1, true, { book: "Cheap", price: -120 }),
    graded(4, true, { book: "Rich", price: 100 }),
  ];
  assert.equal(collapseCensus(rows)[0].book, "Rich");
});

// --- grading ---------------------------------------------------------------------

test("a census row is graded by the same rule a real bet is", () => {
  const scores = new Map<string, Score>([["E1", { home_score: 27, away_score: 20 }]]);
  const out = gradeCensus(
    [
      row({ market: "spread", side: "home", line: -3.5 }),
      row({ market: "spread", side: "away", line: 3.5 }),
      row({ market: "total", side: "over", line: 45.5 }),
      row({ market: "moneyline", side: "home", line: null }),
    ],
    scores,
  );
  assert.deepEqual(out.map((r) => r.covered), [true, false, true, true]);
});

test("a game that has not finished is not graded as a loss", () => {
  assert.deepEqual(gradeCensus([row()], new Map()), []);
});

// --- using the discount ----------------------------------------------------------

test("with nothing measured the edge is used as it stands", () => {
  // Discounting by a guess would invent the number this file exists to measure.
  assert.equal(calibratedEdgePoints(3, null), 3);
  assert.equal(calibratedEdgePoints(3, calibrate([])), 3);
});

test("a slope that has not cleared its own error bar is not applied", () => {
  const thin = calibrate(sample(4, 40, 0.56));
  assert.ok((thin.slope! / thin.slopeSe!) < 2, "this sample should be too thin to use");
  assert.equal(calibratedEdgePoints(3, thin), 3);
});

test("a measured discount is applied once it is real", () => {
  const fit = calibrate([...sample(4, 20_000, 0.5438), ...sample(-4, 20_000, 0.5038)]);
  assert.ok(fit.slope! / fit.slopeSe! > 2);
  assert.ok(Math.abs(calibratedEdgePoints(3, fit) - 1.5) < 0.2);
});

test("a backwards rule is stopped, not inverted", () => {
  // Betting the other side would be staking real money on the sign of a statistic that
  // has not cleared its own error bar. A rule that is backwards is one to stop using.
  const fit = calibrate([...sample(4, 20_000, 0.49), ...sample(-4, 20_000, 0.56)]);
  assert.ok(fit.slope! < 0);
  assert.equal(calibratedEdgePoints(3, fit), 0);
});

test("an edge is never inflated, however good the slope looks", () => {
  const fit = calibrate([...sample(4, 20_000, 0.60), ...sample(-4, 20_000, 0.45)]);
  assert.ok(fit.slope! > 1, "this sample really did beat its own claim");
  // Believing that would be letting one good stretch raise every future estimate.
  assert.equal(calibratedEdgePoints(3, fit), 3);
});
