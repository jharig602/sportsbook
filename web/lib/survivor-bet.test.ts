import assert from "node:assert/strict";
import { test } from "node:test";

import { bestMoneyline, linkToBoard, toBettable } from "./survivor-bet.ts";
import type { Candidate } from "./survivor.ts";
import type { Game } from "./types.ts";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    team: "Jacksonville Jaguars",
    opponent: "Cleveland Browns",
    home: true,
    winProbability: 0.765,
    spread: -8.5,
    commenceTime: "2026-09-13T17:00:00Z",
    eventId: "feed-1",
    ...over,
  };
}

function game(over: Partial<Game> = {}): Game {
  return {
    eventId: "401",
    league: "nfl",
    commenceTime: "2026-09-13T17:00:00Z",
    homeTeam: "Jacksonville Jaguars",
    awayTeam: "Cleveland Browns",
    homeTeamId: "30",
    awayTeamId: "5",
    lastObserved: "2026-09-12T12:00:00Z",
    spread: {},
    total: {},
    moneyline: { home: { line: null, price: -380 }, away: { line: null, price: 300 } },
    ...over,
  };
}

const q = (book: string, side: string, price: number | null) => ({
  book, market: "moneyline", side, price,
});

// --- linking to the board ---------------------------------------------------------

test("a fixture on the board is matched to its ESPN id", () => {
  assert.equal(linkToBoard(candidate(), [game()])?.eventId, "401");
});

test("both teams must match, not just one", () => {
  // A half-match is a different game, and a bet stored against it settles on the
  // wrong result.
  const wrong = game({ awayTeam: "Tennessee Titans" });
  assert.equal(linkToBoard(candidate(), [wrong]), null);
});

test("home and away are not interchangeable", () => {
  const flipped = game({ homeTeam: "Cleveland Browns", awayTeam: "Jacksonville Jaguars" });
  assert.equal(linkToBoard(candidate(), [flipped]), null);
});

test("a kickoff a week away is a different fixture", () => {
  const later = game({ commenceTime: "2026-09-20T17:00:00Z" });
  assert.equal(linkToBoard(candidate(), [later]), null);
});

test("punctuation and case differences between sources do not block a match", () => {
  const messy = game({ homeTeam: "jacksonville  jaguars", awayTeam: "Cleveland Browns." });
  assert.equal(linkToBoard(candidate(), [messy])?.eventId, "401");
});

// --- best price -------------------------------------------------------------------

test("the best American price wins, whichever side of zero it is on", () => {
  const best = bestMoneyline("401", "home", [
    q("BetMGM", "home", -380), q("FanDuel", "home", -350), q("BetRivers", "home", -400),
  ], []);
  assert.deepEqual(best, { price: -350, book: "FanDuel" });
});

test("a price at a book you do not hold is not a price you have", () => {
  const best = bestMoneyline("401", "home", [
    q("Bovada", "home", -300), q("BetMGM", "home", -380),
  ], ["BetMGM", "FanDuel"]);
  assert.deepEqual(best, { price: -380, book: "BetMGM" });
});

test("the other side of the game is not considered", () => {
  assert.equal(bestMoneyline("401", "home", [q("BetMGM", "away", 300)], []), null);
});

// --- end to end -------------------------------------------------------------------

test("a pick on the board comes back loggable, with its return computed", () => {
  const quotes = new Map([["401", [q("BetMGM", "home", -380), q("FanDuel", "home", -350)]]]);
  const bettable = toBettable(candidate(), [game()], quotes, ["BetMGM", "FanDuel"]);
  assert.equal(bettable.eventId, "401");
  assert.equal(bettable.price, -350);
  assert.equal(bettable.book, "FanDuel");
  assert.equal(bettable.blocked, null);
  // 76.5% at -350 pays 0.2857 on a win: 0.765*0.2857 - 0.235.
  assert.ok(Math.abs(bettable.expectedRoi! - (0.765 * (100 / 350) - 0.235)) < 1e-9);
});

test("THE POINT: a safe survivor pick is usually a losing moneyline bet", () => {
  // Survivor wants the highest win probability and does not care what it pays --
  // there is no price. A bet wants value, and a heavy favourite is exactly where the
  // gap is smallest and the vig bites hardest. The two objectives are opposed.
  const bettable = toBettable(candidate(), [game()], new Map(), []);
  assert.equal(bettable.price, -380, "falls back to the board's own book");
  assert.ok(bettable.expectedRoi! < 0, "a -380 favourite at 76.5% loses money");
});

test("a pick that is genuinely priced well is reported as such", () => {
  // Rare, but it happens, and it is the case worth knowing about.
  const generous = new Map([["401", [q("BetMGM", "home", -220)]]]);
  const bettable = toBettable(candidate(), [game()], generous, ["BetMGM"]);
  assert.ok(bettable.expectedRoi! > 0);
});

test("a future fixture is refused rather than logged against an id that cannot settle", () => {
  // game_results is keyed on ESPN ids. A bet stored against the feed's own id would
  // never join to a result, and would sit open for ever looking fine.
  const future = candidate({
    team: "Green Bay Packers", opponent: "Miami Dolphins",
    commenceTime: "2026-12-20T18:00:00Z",
  });
  const bettable = toBettable(future, [game()], new Map(), []);
  assert.equal(bettable.eventId, null);
  assert.equal(bettable.price, null);
  assert.match(bettable.blocked!, /not on the board/i);
});

test("a board fixture with no moneyline says so rather than inventing a price", () => {
  const unpriced = game({ moneyline: {} });
  const bettable = toBettable(candidate(), [unpriced], new Map(), ["BetMGM"]);
  assert.equal(bettable.eventId, "401");
  assert.equal(bettable.price, null);
  assert.match(bettable.blocked!, /no moneyline/i);
});
