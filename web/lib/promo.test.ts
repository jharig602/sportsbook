import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { bestBonusTarget, bestQualifier, progress, promoValue } from "./promo.ts";
import type { Candidate } from "./survivor.ts";

function row(over: Partial<BoardEdge> = {}): BoardEdge {
  return {
    book: "FanDuel", market: "spread", side: "home", line: -3, price: -110,
    consensusLine: -3, consensusProbability: 0.5, advantagePoints: 0,
    fairProbability: 0.5, breakEven: 0.524, expectedRoi: -0.045, edgePoints: -2.4,
    booksCompared: 8, thinConsensus: false, stale: false, note: "",
    eventId: "401", league: "nfl", homeTeam: "Home", awayTeam: "Away",
    commenceTime: "2026-09-13T17:00:00Z", homeTeamId: "1", awayTeamId: "2",
    ...over,
  } as BoardEdge;
}

function cand(team: string, p: number): Candidate {
  return {
    team, opponent: "Other", home: false, winProbability: p, spread: 10,
    commenceTime: "2026-09-13T17:00:00Z", eventId: "e1",
  };
}

// --- the qualifying bet -------------------------------------------------------------

test("the cheapest bet is chosen, even when every option loses money", () => {
  // The point. Six bets WILL be placed; the only question is what they cost.
  const plan = bestQualifier(
    [row({ expectedRoi: -0.045 }), row({ expectedRoi: -0.012 }), row({ expectedRoi: -0.08 })],
    "FanDuel",
    5,
  );
  assert.equal(plan.expectedProfit, 5 * -0.012);
  assert.equal(plan.beatsVig, false, "and it says so rather than implying a good bet");
});

test("a genuinely positive bet is reported as one", () => {
  const plan = bestQualifier([row({ expectedRoi: 0.03 })], "FanDuel", 5);
  assert.equal(plan.beatsVig, true);
  assert.ok(plan.expectedProfit > 0);
});

test("only the required book counts", () => {
  const plan = bestQualifier(
    [row({ book: "Bovada", expectedRoi: 0.2 }), row({ book: "FanDuel", expectedRoi: -0.03 })],
    "FanDuel",
    5,
  );
  assert.equal(plan.pick!.book, "FanDuel");
  assert.ok(plan.expectedProfit < 0, "a price you cannot reach is not an option");
});

test("a stale quote is never the recommendation", () => {
  const plan = bestQualifier([row({ stale: true, expectedRoi: 0.5 })], "FanDuel", 5);
  assert.equal(plan.pick, null);
});

test("an empty board recommends nothing rather than something", () => {
  const plan = bestQualifier([], "FanDuel", 5);
  assert.equal(plan.pick, null);
  assert.equal(plan.expectedProfit, 0);
});

// --- the bonus bet ------------------------------------------------------------------

test("longer odds convert a bonus bet better", () => {
  const short = bestBonusTarget([{ candidate: cand("A", 0.40), price: 250 }], 50);
  const long = bestBonusTarget([{ candidate: cand("B", 0.17), price: 700 }], 50);
  assert.ok(long!.value > short!.value);
  assert.ok(long!.conversion > 0.7, "a +700 dog converts most of the face value");
});

test("the model's probability is used, not the price's", () => {
  // Using the implied price would bake in the favourite-longshot bias and push every
  // recommendation toward +5000 shots that win far less often than they are priced to.
  const generous = bestBonusTarget([{ candidate: cand("A", 0.25), price: 400 }], 50);
  const implied = 100 / (400 + 100); // 20%
  assert.ok(generous!.candidate.winProbability > implied);
  assert.ok(Math.abs(generous!.value - 0.25 * 4 * 50) < 1e-9);
});

test("extremes on both sides are refused", () => {
  assert.equal(bestBonusTarget([{ candidate: cand("Fav", 0.7), price: -200 }], 50), null);
  assert.equal(bestBonusTarget([{ candidate: cand("Moon", 0.02), price: 5000 }], 50), null);
});

test("the best inside the band wins", () => {
  const best = bestBonusTarget(
    [
      { candidate: cand("Low", 0.30), price: 300 },
      { candidate: cand("Mid", 0.18), price: 650 },
      { candidate: cand("High", 0.09), price: 1100 },
    ],
    50,
  );
  assert.equal(best!.candidate.team, "Mid", `got ${best!.candidate.team}`);
});

// --- progress -----------------------------------------------------------------------

test("progress counts days actually logged, not days elapsed", () => {
  // A day you forgot is a day that did not count. Assuming otherwise would announce
  // the bonus as earned while it was not.
  const p = progress(["2026-09-10", "2026-09-11", "2026-09-11"], 6);
  assert.equal(p.done, 2, "the duplicate is one day");
  assert.equal(p.today, 3);
  assert.equal(p.complete, false);
});

test("completion is reported once the last qualifying bet is in", () => {
  const days = ["a", "b", "c", "d", "e", "f"];
  const p = progress(days, 6);
  assert.equal(p.complete, true);
  assert.equal(p.today, null);
});

test("EACH stake earns its own bonus, so both sides scale with the days", () => {
  // Six $5 bets cost about $1.35 in expectation; six $50 bonuses placed well are worth
  // near $220. Treating it as one bonus for six stakes understates it sixfold and
  // could make a plainly good deal look like a close call.
  const perBet = 5 * -0.045;
  const value = promoValue(perBet, 6, 37);
  assert.ok(Math.abs(value - 6 * (37 - 0.225)) < 1e-9);
  assert.ok(value > 200, `expected the promotion to be worth ~$220, got ${value.toFixed(2)}`);

  const ifItWereOneBonus = 37 - Math.abs(perBet) * 6;
  assert.ok(value > ifItWereOneBonus * 5, "the difference is not a rounding error");
});
