import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { bestParlay, learnedShift, openEvents, pickDailyBet, type GradedPick } from "./daily-bet.ts";
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

// --- the parlay of the day ----------------------------------------------------------

test("the parlay is the likeliest two games, and never the single's game", () => {
  const result = pickDailyBet(
    [
      edge({ eventId: "A", fairProbability: 0.6 }),
      edge({ eventId: "B", fairProbability: 0.58 }),
      edge({ eventId: "C", fairProbability: 0.56 }),
    ],
    base,
  );
  assert.equal(result.pick?.row.eventId, "A");
  const legs = result.parlay!.legs.map((l) => l.row.eventId);
  assert.deepEqual(legs, ["B", "C"], "A is the single, so it stays out of the parlay");
  assert.ok(Math.abs(result.parlay!.p - 0.58 * 0.56) < 1e-12);
});

test("it is priced rounded down, as books pay, and still has to be worth it there", () => {
  const result = pickDailyBet(
    [edge({ eventId: "A", fairProbability: 0.6 }), edge({ eventId: "B" }), edge({ eventId: "C" })],
    base,
  );
  const parlay = result.parlay!;
  assert.equal(parlay.price, 264, "two -110 legs: 3.6446 decimal, +264 after rounding down");
  assert.ok(Math.abs(parlay.roi - (parlay.p * 3.64 - 1)) < 1e-12);
  assert.ok(parlay.roi > 0);
});

test("two prices on one game are never a parlay", () => {
  // A spread and a moneyline on the same game win and lose together.
  const candidates = pickDailyBet(
    [
      edge({ eventId: "A", fairProbability: 0.6 }),
      edge({ eventId: "B", fairProbability: 0.58 }),
      edge({ eventId: "B", market: "moneyline", line: null, price: -150, fairProbability: 0.66, breakEven: 0.6 }),
    ],
    base,
  );
  // B is now the likeliest single; with A as the only other game there is exactly one pair
  // to consider once B is set aside -- and it needs two games.
  assert.equal(candidates.pick?.row.eventId, "B");
  assert.equal(candidates.parlay, null);
});

test("a ticket cannot span two books", () => {
  const result = pickDailyBet(
    [
      edge({ eventId: "A", fairProbability: 0.6 }),
      edge({ eventId: "B", book: "FanDuel" }),
      edge({ eventId: "C", book: "BetMGM" }),
    ],
    { ...base, myBooks: ["FanDuel", "BetMGM"] },
  );
  assert.equal(result.parlay, null);
});

test("the book with the likelier pair wins", () => {
  const sorted = pickDailyBet(
    [
      edge({ eventId: "X", fairProbability: 0.7 }),
      edge({ eventId: "B", book: "BetMGM", fairProbability: 0.62 }),
      edge({ eventId: "C", book: "BetMGM", fairProbability: 0.6 }),
      edge({ eventId: "D", book: "FanDuel", fairProbability: 0.57 }),
      edge({ eventId: "E", book: "FanDuel", fairProbability: 0.56 }),
    ],
    { ...base, myBooks: ["FanDuel", "BetMGM"] },
  );
  assert.equal(sorted.parlay!.book, "BetMGM");
});

test("no pair means no parlay, and no bet at all means neither", () => {
  assert.equal(pickDailyBet([edge({ eventId: "A" }), edge({ eventId: "B" })], base).parlay, null,
    "one game is left once the single is set aside");
  const nothing = pickDailyBet([edge({ fairProbability: 0.5 })], base);
  assert.equal(nothing.pick, null);
  assert.equal(nothing.parlay, null);
});

test("games you hold are kept out of the parlay too", () => {
  const result = pickDailyBet(
    [edge({ eventId: "A", fairProbability: 0.6 }), edge({ eventId: "B" }), edge({ eventId: "C" }), edge({ eventId: "D" })],
    { ...base, open: new Set(["B"]) },
  );
  assert.deepEqual(result.parlay!.legs.map((l) => l.row.eventId), ["C", "D"]);
});

test("bestParlay on its own refuses a pair that loses money at the rounded price", () => {
  // Two legs that barely clear alone can fall below zero once the book rounds down.
  const thin = [
    { row: edge({ eventId: "P", price: -110 }), p: 0.524, edgePoints: 0.03, roi: 0.0004, adjustment: learnedShift([], "spread", "nfl") },
    { row: edge({ eventId: "Q", price: -110 }), p: 0.524, edgePoints: 0.03, roi: 0.0004, adjustment: learnedShift([], "spread", "nfl") },
  ];
  assert.equal(bestParlay(thin, new Set()), null);
});

// --- never against your own team -------------------------------------------------

test("a bet against your team is never the pick, and it says how many it skipped", () => {
  // The fixture's home side is the Lions. The Bills side is the one against them.
  const result = pickDailyBet(
    [
      edge({ eventId: "E1", side: "away", line: 3, fairProbability: 0.7 }),
      edge({ eventId: "E2", side: "home", fairProbability: 0.56 }),
    ],
    { ...base, favourites: ["Detroit Lions"] },
  );
  assert.equal(result.pick?.row.eventId, "E2", "the likelier bet was against the Lions");
  assert.equal(result.skippedFavourite, 1);
});

test("backing your own team is still allowed", () => {
  const result = pickDailyBet(
    [edge({ side: "home", fairProbability: 0.58 })],
    { ...base, favourites: ["Detroit Lions"] },
  );
  assert.ok(result.pick);
  assert.equal(result.skippedFavourite, 0);
});

test("when everything left is against your team, the reason says so", () => {
  const result = pickDailyBet(
    [edge({ side: "away", line: 3, fairProbability: 0.7 })],
    { ...base, favourites: ["Detroit Lions"] },
  );
  assert.equal(result.pick, null);
  assert.match(result.reason!, /against one of your teams/);
});

test("the parlay of the day inherits the rule, because it draws on the same bets", () => {
  const result = pickDailyBet(
    [
      edge({ eventId: "A", side: "away", line: 3, fairProbability: 0.62 }),
      edge({ eventId: "B", homeTeam: "Green Bay Packers", awayTeam: "Chicago Bears", fairProbability: 0.6 }),
      edge({ eventId: "C", homeTeam: "Dallas Cowboys", awayTeam: "New York Giants", fairProbability: 0.59 }),
    ],
    { ...base, favourites: ["Detroit Lions"] },
  );
  const parlayGames = (result.parlay?.legs ?? []).map((leg) => leg.row.eventId);
  assert.ok(!parlayGames.includes("A"), `a leg bet against the Lions: ${parlayGames}`);
});
