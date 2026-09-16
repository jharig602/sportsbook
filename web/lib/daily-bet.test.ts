import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { learnedShift, openEvents, pickDailyBet, type GradedPick } from "./daily-bet.ts";
import type { Bet } from "./settle.ts";

function edge(over: Partial<BoardEdge> = {}): BoardEdge {
  return {
    book: "FanDuel",
    market: "spread",
    side: "home",
    line: -3,
    price: -110,
    consensusLine: -4,
    consensusProbability: 0.5,
    advantagePoints: 1,
    fairProbability: 0.56,
    breakEven: 110 / 210,
    expectedRoi: 0.07,
    edgePoints: 3.6,
    booksCompared: 6,
    thinConsensus: false,
    stale: false,
    note: "",
    eventId: "E1",
    gameSpread: -3,
    league: "nfl",
    homeTeam: "Detroit Lions",
    awayTeam: "Buffalo Bills",
    commenceTime: "2026-09-20T17:00:00Z",
    homeTeamId: "8",
    awayTeamId: "2",
    ...over,
  } as BoardEdge;
}

function bet(over: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1", placed_at: "2026-09-15T12:00:00Z", league: "nfl", event_id: "E1",
    home_team: null, away_team: null, commence_time: null, market: "spread", side: "home",
    line: -3, price: -110, stake: 20, book: "FanDuel", model_probability: null,
    market_probability: null, rule_version_id: null, note: null, supersedes: null,
    ...over,
  };
}

const graded = (market: string, league: string, p: number, won: boolean | null, n: number): GradedPick[] =>
  Array.from({ length: n }, () => ({ market, league, fair_probability: p, result_covered: won }));

const base = { myBooks: ["FanDuel"], open: new Set<string>(), grades: [] as GradedPick[], maxSpread: 28 };

// --- learning -----------------------------------------------------------------

test("with nothing graded there is nothing to learn", () => {
  const a = learnedShift([], "spread", "nfl");
  assert.equal(a.n, 0);
  assert.equal(a.shift, 0);
});

test("a cell that wins more than predicted is nudged up, one that wins less is nudged down", () => {
  const hot = learnedShift(graded("spread", "nfl", 0.55, true, 30), "spread", "nfl");
  assert.ok(hot.shift > 0);
  const cold = learnedShift(graded("total", "ncaaf", 0.55, false, 30), "total", "ncaaf");
  assert.ok(cold.shift < 0);
});

test("the correction is shrunk: a small sample moves it a little, a big one a lot", () => {
  // Same raw gap (predicted 55%, actual 45%), very different evidence behind it.
  const mixed = (n: number): GradedPick[] => [
    ...graded("spread", "nfl", 0.55, true, Math.round(n * 0.45)),
    ...graded("spread", "nfl", 0.55, false, n - Math.round(n * 0.45)),
  ];
  const small = learnedShift(mixed(20), "spread", "nfl").shift;
  const large = learnedShift(mixed(2000), "spread", "nfl").shift;
  assert.ok(Math.abs(small) < 0.02, `20 results moved it ${small}`);
  assert.ok(Math.abs(large) > 0.09, `2000 results moved it only ${large}`);
  assert.ok(large < 0 && small < 0);
});

test("each market and league learns only from its own picks", () => {
  const grades = [...graded("spread", "nfl", 0.5, false, 200)];
  assert.ok(learnedShift(grades, "spread", "nfl").shift < 0);
  assert.equal(learnedShift(grades, "spread", "ncaaf").shift, 0);
  assert.equal(learnedShift(grades, "moneyline", "nfl").shift, 0);
});

test("pushes teach nothing about a probability", () => {
  const a = learnedShift(graded("spread", "nfl", 0.5, null, 50), "spread", "nfl");
  assert.equal(a.n, 0);
  assert.equal(a.shift, 0);
});

// --- games you already hold -----------------------------------------------------

test("a game with a standing bet is open", () => {
  assert.deepEqual([...openEvents([bet()], new Set())], ["E1"]);
});

test("a finished game is not", () => {
  assert.equal(openEvents([bet()], new Set(["E1"])).size, 0);
});

test("a voided bet does not block its game", () => {
  const original = bet({ bet_id: "b1" });
  const tombstone = bet({ bet_id: "b2", supersedes: "b1", voided: true });
  assert.equal(openEvents([original, tombstone], new Set()).size, 0);
});

test("a corrected bet blocks the game it now names, not the one it used to", () => {
  const original = bet({ bet_id: "b1", event_id: "E1" });
  const fixed = bet({ bet_id: "b2", event_id: "E2", supersedes: "b1" });
  assert.deepEqual([...openEvents([original, fixed], new Set())], ["E2"]);
});

test("a cashed-out ticket is finished even while its game is not", () => {
  assert.equal(openEvents([bet({ cashout: 12 })], new Set()).size, 0);
});

test("every leg of a parlay holds its game", () => {
  const legs = [bet({ bet_id: "l1", event_id: "E1", parlay_id: "P" }), bet({ bet_id: "l2", event_id: "E2", parlay_id: "P" })];
  assert.deepEqual([...openEvents(legs, new Set())].sort(), ["E1", "E2"]);
});

// --- the pick -------------------------------------------------------------------

test("never a game you already have money on, and it says how many were skipped", () => {
  const result = pickDailyBet(
    [edge({ eventId: "E1", fairProbability: 0.7 }), edge({ eventId: "E2", fairProbability: 0.56 })],
    { ...base, open: new Set(["E1"]) },
  );
  assert.equal(result.pick?.row.eventId, "E2");
  assert.equal(result.skippedOpen, 1);
});

test("the likeliest winner wins, among bets that all clear the edge", () => {
  const result = pickDailyBet(
    [
      edge({ eventId: "A", market: "moneyline", side: "away", line: null, price: 400, fairProbability: 0.24, breakEven: 0.2 }),
      edge({ eventId: "B", fairProbability: 0.58 }),
      edge({ eventId: "C", fairProbability: 0.55 }),
    ],
    base,
  );
  assert.equal(result.pick?.row.eventId, "B");
  assert.equal(result.qualifying, 3);
});

test("a bet that does not clear the house edge by enough is never the pick", () => {
  // 53% at -110 is above break-even, but by less than the 1.5-point bar.
  const result = pickDailyBet([edge({ fairProbability: 0.53 })], base);
  assert.equal(result.pick, null);
  assert.match(result.reason!, /clears the house edge/);
});

test("learning can take a pick away", () => {
  const row = edge({ fairProbability: 0.56 });
  assert.ok(pickDailyBet([row], base).pick, "fine before anything is graded");
  const burned = graded("spread", "nfl", 0.56, false, 400);
  assert.equal(pickDailyBet([row], { ...base, grades: burned }).pick, null);
});

test("and learning can add one", () => {
  const row = edge({ fairProbability: 0.53 });
  assert.equal(pickDailyBet([row], base).pick, null);
  const proven = graded("spread", "nfl", 0.53, true, 400);
  const result = pickDailyBet([row], { ...base, grades: proven });
  assert.ok(result.pick);
  assert.ok(result.pick!.p > 0.53);
  assert.equal(result.pick!.adjustment.n, 400);
});

test("books you cannot use are ignored, unless you have not chosen any", () => {
  const rows = [edge({ book: "LowVig.ag", fairProbability: 0.7, eventId: "X" }), edge({ eventId: "Y" })];
  assert.equal(pickDailyBet(rows, base).pick?.row.eventId, "Y");
  assert.equal(pickDailyBet(rows, { ...base, myBooks: [] }).pick?.row.eventId, "X");
});

test("stale prices and blowouts are never considered", () => {
  const result = pickDailyBet(
    [edge({ stale: true, eventId: "S" }), edge({ gameSpread: -35, eventId: "B" })],
    base,
  );
  assert.equal(result.considered, 0);
  assert.equal(result.pick, null);
  assert.match(result.reason!, /Nothing is priced/);
});

test("when every game is one you hold, it says that rather than 'no edge'", () => {
  const result = pickDailyBet([edge({ eventId: "E1" })], { ...base, open: new Set(["E1"]) });
  assert.equal(result.pick, null);
  assert.match(result.reason!, /already have money on/);
});
