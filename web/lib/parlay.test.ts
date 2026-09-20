import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { buildParlay, oneInHowMany, sameGameProblem, typicalParlayRoi } from "./parlay.ts";

function leg(over: Partial<BoardEdge> = {}): BoardEdge {
  return {
    book: "FanDuel",
    market: "spread",
    side: "home",
    line: -3,
    price: -110,
    consensusLine: -3,
    consensusProbability: 0.5,
    advantagePoints: 0,
    fairProbability: 0.5,
    breakEven: 0.5238,
    expectedRoi: -0.045,
    edgePoints: -2.4,
    booksCompared: 8,
    stale: false,
    eventId: "e1",
    league: "nfl",
    homeTeam: "Home",
    awayTeam: "Away",
    commenceTime: "2026-09-13T17:00:00Z",
    homeTeamId: null,
    awayTeamId: null,
    ...over,
  } as BoardEdge;
}

test("expected value compounds, which is the whole story", () => {
  // Two legs that each return +5% make +10.25%, not +5%. The same formula pointed the
  // other way is why an ordinary parlay is the worst bet on the menu.
  const good = leg({ eventId: "a", price: 100, fairProbability: 0.525 });
  const parlay = buildParlay([good, { ...good, eventId: "b" }]);
  assert.ok(Math.abs(parlay.expectedRoi - (1.05 * 1.05 - 1)) < 1e-9, `${parlay.expectedRoi}`);
});

test("a parlay of ordinary legs is far worse than any one of them", () => {
  // -4.5% a leg is a normal hold. Four of those is not -4.5%.
  const ordinary = (id: string) => leg({ eventId: id, price: -110, fairProbability: 0.5 });
  const four = buildParlay(["a", "b", "c", "d"].map(ordinary));
  assert.ok(four.expectedRoi < -0.16, `four ordinary legs returned ${four.expectedRoi}`);
  assert.ok(Math.abs(four.expectedRoi - typicalParlayRoi(4)) < 0.01);
});

test("the odds are the product, and round-trip through American", () => {
  const evens = leg({ eventId: "a", price: 100, fairProbability: 0.5 });
  const parlay = buildParlay([evens, { ...evens, eventId: "b" }]);
  assert.equal(parlay.decimal, 4); // 2 x 2
  assert.equal(parlay.americanPrice, 300); // +300 pays 3 to 1
  assert.equal(parlay.winProbability, 0.25);
});

test("a single leg is just that bet, unchanged", () => {
  // The identity that keeps the builder honest at n = 1.
  const one = leg({ price: 150, fairProbability: 0.44 });
  const parlay = buildParlay([one]);
  assert.ok(Math.abs(parlay.decimal - 2.5) < 1e-9);
  assert.ok(Math.abs(parlay.expectedRoi - (0.44 * 2.5 - 1)) < 1e-9);
  assert.equal(parlay.correlatedGames.length, 0);
});

test("two legs from the same game are flagged, because the maths stops applying", () => {
  // A team covering and the game going over move together. Multiplying the prices is
  // simply wrong, and books price same-game parlays with their own adjustment anyway.
  const parlay = buildParlay([
    leg({ eventId: "same", market: "spread" }),
    leg({ eventId: "same", market: "total", side: "over" }),
  ]);
  assert.deepEqual(parlay.correlatedGames, ["same"]);
});

test("legs from different games are not flagged", () => {
  const parlay = buildParlay([leg({ eventId: "a" }), leg({ eventId: "b" })]);
  assert.deepEqual(parlay.correlatedGames, []);
});

test("a leg with no price cannot be priced, and says so", () => {
  // Rather than quietly treating a missing price as evens, which would invent an edge.
  const parlay = buildParlay([leg({ eventId: "a" }), leg({ eventId: "b", price: null })]);
  assert.equal(parlay.priceable, false);
  assert.equal(parlay.expectedRoi, 0);
});

test("an empty parlay is not priceable", () => {
  const parlay = buildParlay([]);
  assert.equal(parlay.priceable, false);
  assert.equal(parlay.legs.length, 0);
});

test("adding a losing leg to winning ones can sink the whole thing", () => {
  // The property that makes a builder worth having: you can watch it happen.
  const good = leg({ eventId: "a", price: 100, fairProbability: 0.55 }); // +10%
  const bad = leg({ eventId: "b", price: -200, fairProbability: 0.6 }); // -10%
  assert.ok(buildParlay([good]).expectedRoi > 0);
  assert.ok(buildParlay([good, bad]).expectedRoi < buildParlay([good]).expectedRoi);
});

test("how often it pays is reported separately from what it is worth", () => {
  // A four-leg parlay of 70% legs is positive on paper and loses three times in four.
  const p = 0.7 ** 4;
  assert.ok(Math.abs(oneInHowMany(p) - 1 / p) < 1e-9);
  assert.ok(oneInHowMany(p) > 4);
  assert.equal(oneInHowMany(0), Infinity);
});

// --- same-game tickets ----------------------------------------------------------

test("legs from one game are allowed onto a ticket", () => {
  // Refused for a while on the grounds that grading would multiply them. It does not:
  // settleParlay uses the book's stored combined price and whether every leg won.
  assert.equal(
    sameGameProblem([
      { event_id: "g1", market: "spread", side: "home", line: -3.5 },
      { event_id: "g1", market: "total", side: "over", line: 45.5 },
    ]),
    null,
  );
});

test("the same leg twice is a typing mistake", () => {
  const problem = sameGameProblem([
    { event_id: "g1", market: "spread", side: "home", line: -3.5 },
    { event_id: "g1", market: "spread", side: "home", line: -3.5 },
  ]);
  assert.match(problem ?? "", /twice/);
});

test("opposite sides of one number cannot both win", () => {
  assert.ok(
    sameGameProblem([
      { event_id: "g1", market: "total", side: "over", line: 45.5 },
      { event_id: "g1", market: "total", side: "under", line: 45.5 },
    ]),
  );
  assert.ok(
    sameGameProblem([
      { event_id: "g1", market: "moneyline", side: "home", line: null },
      { event_id: "g1", market: "moneyline", side: "away", line: null },
    ]),
  );
});

test("opposite sides of different numbers are a middle, not a contradiction", () => {
  // Over 44.5 and under 47.5 both land on a 46-point game. Unusual to log, but real.
  assert.equal(
    sameGameProblem([
      { event_id: "g1", market: "total", side: "over", line: 44.5 },
      { event_id: "g1", market: "total", side: "under", line: 47.5 },
    ]),
    null,
  );
});

test("opposite sides in different games are just a parlay", () => {
  assert.equal(
    sameGameProblem([
      { event_id: "g1", market: "total", side: "over", line: 45.5 },
      { event_id: "g2", market: "total", side: "under", line: 45.5 },
    ]),
    null,
  );
});
