/**
 * Same-game parlay pricing tests.
 *
 * The product here is a price to beat, so the cases that matter are the ones where the
 * price would be wrong in a direction that looks attractive: a ticket made to seem
 * likelier than it is, or a lottery ticket sorted to the top because long odds convert
 * well on a bonus bet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { type ScoreLeg, type ScoreModel, jointProbability } from "./joint-score.ts";
import type { MarginModel } from "./probability.ts";
import {
  type PricedLeg,
  type SgpGame,
  bestSameGameParlays,
  everyLegEarnsItsPlace,
  legFor,
  priceSameGame,
  sgpEv,
  sgpGamesFromBoard,
} from "./sgp.ts";

function margin(): MarginModel {
  const pmf: Record<string, number> = {};
  for (let halves = -40; halves <= 40; halves += 1) pmf[String(halves)] = 0.02;
  pmf["6"] = 0.1;
  pmf["-6"] = 0.1;
  pmf["0"] = 0.04;
  const total = Object.values(pmf).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(pmf)) pmf[k] /= total;
  return { league: "nfl", games: 500, mean: 0, sd: 13.5, lo: -20, hi: 20, pmf };
}

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

const MARGINS = { nfl: margin() };
const SCORES = { nfl: score() };
const LINES = { homeSpread: -3.5, total: 45.5 };

function priced(
  market: PricedLeg["market"],
  side: PricedLeg["side"],
  line: number | null,
  price: number,
): PricedLeg {
  return {
    leg: legFor(market, side, line)!,
    price,
    market,
    side,
    line,
    label: `${side} ${line ?? ""}`.trim(),
    edgePoints: null,
  };
}

function game(legs: PricedLeg[]): SgpGame {
  return {
    eventId: "g1",
    book: "FanDuel",
    league: "nfl",
    homeTeam: "Home",
    awayTeam: "Away",
    commenceTime: "2026-09-21T17:00:00Z",
    lines: LINES,
    legs,
  };
}

// --- the fair price -------------------------------------------------------------

test("the fair price is the one that makes the ticket break even", () => {
  const quote = priceSameGame(margin(), score(), LINES, [
    { market: "spread", side: "home", line: -3.5 },
    { market: "total", side: "over", line: 45.5 },
  ])!;
  // At its own fair price the ticket returns exactly nothing. If this drifts, every
  // "price to beat" in the app is off by the same amount and nothing would show it.
  const ev = sgpEv(quote, quote.fairAmerican!);
  assert.ok(Math.abs(ev!) < 0.01, `ev ${ev}`);
});

test("a push is worth the stake back, not a loss", () => {
  const withPush = priceSameGame(margin(), score(), { homeSpread: -3, total: 45.5 }, [
    { market: "spread", side: "home", line: -3 },
  ])!;
  assert.ok(withPush.push > 0);
  // Fair decimal is (1 - push) / win. Treating the push as a loss would use 1 / win,
  // which is a longer price -- it would demand more from the book than the bet is worth
  // and quietly reject good tickets.
  assert.ok(withPush.fairDecimal! < 1 / withPush.win);
});

test("an impossible ticket has no price rather than a very long one", () => {
  const quote = priceSameGame(margin(), score(), LINES, [
    { market: "total", side: "over", line: 45.5 },
    { market: "total", side: "under", line: 45.5 },
  ])!;
  assert.equal(quote.win, 0);
  assert.equal(quote.fairDecimal, null);
  assert.equal(quote.fairAmerican, null);
});

// --- correlation ----------------------------------------------------------------

test("a team total shortens the fair price of the side that scores it", () => {
  const legs = [
    { market: "moneyline", side: "home" },
    { market: "team_total", team: "home", side: "over", line: 24.5 },
  ] as const;
  const quote = priceSameGame(margin(), score(), LINES, [...legs])!;
  assert.ok(quote.correlationShift > 0.15, `shift ${quote.correlationShift}`);
  // Likelier than the product means the fair price is SHORTER than the product's. A
  // builder that reported the product here would tell you to accept far too little.
  assert.ok(quote.fairDecimal! < 1 / quote.independentWin);
});

test("the opponent's team total lengthens it", () => {
  const quote = priceSameGame(margin(), score(), LINES, [
    { market: "moneyline", side: "home" },
    { market: "team_total", team: "away", side: "over", line: 24.5 },
  ])!;
  assert.ok(quote.correlationShift < 0, `shift ${quote.correlationShift}`);
});

// --- bonus bets -----------------------------------------------------------------

test("a bonus bet ignores the stake it never gets back", () => {
  const quote = priceSameGame(margin(), score(), LINES, [
    { market: "spread", side: "home", line: -3.5 },
    { market: "total", side: "over", line: 45.5 },
  ])!;
  const cash = sgpEv(quote, 260)!;
  const bonus = sgpEv(quote, 260, { bonus: true })!;
  // A losing bonus bet costs nothing, so its return is always the better of the two.
  assert.ok(bonus > cash);
  // And at the fair price it is still positive, which is the whole reason a bonus bet
  // is worth something at all.
  assert.ok(sgpEv(quote, quote.fairAmerican!, { bonus: true })! > 0);
});

test("a bonus bet converts better at a longer price", () => {
  const short = priceSameGame(margin(), score(), LINES, [
    { market: "spread", side: "home", line: 10.5 },
    { market: "total", side: "over", line: 30.5 },
  ])!;
  const long = priceSameGame(margin(), score(), LINES, [
    { market: "spread", side: "home", line: -17.5 },
    { market: "total", side: "over", line: 62.5 },
  ])!;
  assert.ok(long.fairDecimal! > short.fairDecimal!);
  assert.ok(1 - 1 / long.fairDecimal! > 1 - 1 / short.fairDecimal!);
});

// --- refusals -------------------------------------------------------------------

test("a price no book could print is refused", () => {
  const quote = priceSameGame(margin(), score(), LINES, [
    { market: "moneyline", side: "home" },
    { market: "total", side: "over", line: 45.5 },
  ])!;
  assert.equal(sgpEv(quote, 50), null);
  assert.equal(sgpEv(quote, Number.NaN), null);
});

test("a league with no fitted model produces no picks", () => {
  const picks = bestSameGameParlays(
    [{ ...game([priced("spread", "home", -3.5, -110), priced("total", "over", 45.5, -110)]), league: "ncaaf" }],
    MARGINS,
    SCORES,
  );
  assert.deepEqual(picks, []);
});

// --- the ranking ----------------------------------------------------------------

test("a long lottery ticket does not outrank a ticket that actually pays", () => {
  // The trap this ranking exists to avoid. A bonus bet converts better at long odds, so
  // sorting by price would put the deep alternate line first every time -- and its price
  // is long precisely because it almost never wins.
  const board = game([
    priced("spread", "home", -3.5, -110),
    priced("total", "over", 45.5, -110),
    priced("spread", "home", -17.5, -110), // absurd price for the line: a trap leg
  ]);
  const picks = bestSameGameParlays([board], MARGINS, SCORES, { bonus: true, maxLegs: 2 });
  assert.ok(picks.length > 0);
  const best = picks[0];
  assert.ok(
    !best.legs.some((leg) => leg.line === -17.5),
    `ranked the lottery leg first: ${best.legs.map((l) => l.label).join(" + ")}`,
  );
});

test("better prices on the same legs buy more markup budget", () => {
  const cheap = game([priced("spread", "home", -3.5, -110), priced("total", "over", 45.5, -110)]);
  const rich = game([priced("spread", "home", -3.5, 110), priced("total", "over", 45.5, 110)]);
  const a = bestSameGameParlays([cheap], MARGINS, SCORES, { maxLegs: 2 })[0];
  const b = bestSameGameParlays([rich], MARGINS, SCORES, { maxLegs: 2 })[0];
  assert.ok(b.markupBudget > a.markupBudget);
  // The fair price does not move -- only what the book is paying does. Mixing those up
  // would let a generous price masquerade as a likelier ticket.
  assert.equal(a.quote.fairAmerican, b.quote.fairAmerican);
});

test("markup budget is how far the book may mark the ticket down", () => {
  const board = game([priced("spread", "home", -3.5, -110), priced("total", "over", 45.5, -110)]);
  const pick = bestSameGameParlays([board], MARGINS, SCORES, { maxLegs: 2 })[0];
  // At exactly the budget, the offered price equals the fair price and the edge is zero.
  const marked = pick.independentDecimal / (1 + pick.markupBudget);
  assert.ok(Math.abs(marked - pick.quote.fairDecimal!) < 1e-9);
});

test("games already carrying a bet are left out", () => {
  const board = game([priced("spread", "home", -3.5, -110), priced("total", "over", 45.5, -110)]);
  const picks = bestSameGameParlays([board], MARGINS, SCORES, { exclude: new Set(["g1"]) });
  assert.deepEqual(picks, []);
});

test("two sides of one market never appear on the same ticket", () => {
  const board = game([
    priced("total", "over", 45.5, -110),
    priced("total", "under", 45.5, -110),
    priced("spread", "home", -3.5, -110),
  ]);
  for (const pick of bestSameGameParlays([board], MARGINS, SCORES, { maxLegs: 3, limit: 50 })) {
    const sides = pick.legs.filter((l) => l.market === "total").map((l) => l.side);
    assert.ok(!(sides.includes("over") && sides.includes("under")));
  }
});

test("a moneyline leg needs no line and a spread leg does", () => {
  assert.deepEqual(legFor("moneyline", "home", null), { market: "moneyline", side: "home" });
  assert.equal(legFor("spread", "home", null), null);
  assert.equal(legFor("total", "over", null), null);
});

// --- building candidates off the board ------------------------------------------

function boardRow(over: Partial<BoardEdge> = {}): BoardEdge {
  return {
    book: "FanDuel",
    market: "spread",
    side: "home",
    line: -3.5,
    price: -110,
    consensusLine: null,
    consensusProbability: null,
    advantagePoints: null,
    fairProbability: null,
    breakEven: null,
    expectedRoi: null,
    edgePoints: null,
    eventId: "g1",
    gameSpread: -3.5,
    league: "nfl",
    homeTeam: "Home",
    awayTeam: "Away",
    commenceTime: "2026-09-21T17:00:00Z",
    homeTeamId: null,
    awayTeamId: null,
    ...overrides(over),
  } as BoardEdge;
}

function overrides(o: Partial<BoardEdge>): Partial<BoardEdge> {
  return o;
}

test("a game without both numbers is skipped, not filled in", () => {
  // A ticket is priced off one scoreline. Half a scoreline prices nothing, and a league
  // average in place of the missing half would invent the quantity the ticket turns on.
  const noTotal = sgpGamesFromBoard([
    boardRow({ market: "spread", side: "home" }),
    boardRow({ market: "moneyline", side: "home", line: null, price: -160 }),
  ]);
  assert.deepEqual(noTotal, []);

  const noSpread = sgpGamesFromBoard([
    boardRow({ market: "total", side: "over", line: 45.5, gameSpread: null }),
    boardRow({ market: "total", side: "under", line: 45.5, gameSpread: null }),
  ]);
  assert.deepEqual(noSpread, []);
});

test("a ticket never mixes books", () => {
  // A same-game parlay is placed in one app. Building it from the best price for each
  // leg across several books produced tickets nobody could place.
  const games = sgpGamesFromBoard([
    boardRow({ book: "FanDuel", market: "spread", side: "home", price: -115 }),
    boardRow({ book: "DraftKings", market: "spread", side: "home", price: -105 }),
    boardRow({ book: "FanDuel", market: "total", side: "over", line: 45.5, price: -110 }),
  ]);
  // DraftKings has only one leg on this game, so only FanDuel can make a ticket -- at
  // FanDuel's own spread price, not DraftKings' better one.
  assert.equal(games.length, 1);
  assert.equal(games[0].book, "FanDuel");
  assert.equal(games[0].legs.find((l) => l.market === "spread")!.price, -115);
});

test("each book is its own candidate", () => {
  const games = sgpGamesFromBoard([
    boardRow({ book: "FanDuel", market: "spread", side: "home", line: -3.5 }),
    boardRow({ book: "FanDuel", market: "total", side: "over", line: 45.5 }),
    boardRow({ book: "BetMGM", market: "spread", side: "home", line: -3 }),
    boardRow({ book: "BetMGM", market: "total", side: "over", line: 45.5 }),
  ]);
  const byBook = new Map(games.map((g) => [g.book, g]));
  assert.deepEqual([...byBook.keys()].sort(), ["BetMGM", "FanDuel"]);
  // Each carries its own number, never the other book's.
  assert.equal(byBook.get("FanDuel")!.legs.find((l) => l.market === "spread")!.line, -3.5);
  assert.equal(byBook.get("BetMGM")!.legs.find((l) => l.market === "spread")!.line, -3);
});

test("the reference line is every book's consensus, not only yours", () => {
  // The Gardner-Webb card: legs chosen because your book beats the market, then priced
  // against your book's own numbers, which erased the difference they were chosen for.
  const rows = [
    boardRow({ book: "FanDuel", market: "spread", side: "home", line: -3 }),
    boardRow({ book: "FanDuel", market: "total", side: "under", line: 52.5 }),
    boardRow({ book: "Caesars", market: "spread", side: "home", line: -4 }),
    boardRow({ book: "Caesars", market: "total", side: "under", line: 51.5 }),
    boardRow({ book: "DraftKings", market: "spread", side: "home", line: -4 }),
    boardRow({ book: "DraftKings", market: "total", side: "under", line: 51.5 }),
  ];
  const [built] = sgpGamesFromBoard(rows, { books: ["FanDuel"] });
  assert.equal(built.book, "FanDuel");
  assert.equal(built.lines.homeSpread, -4, "the market's number, not FanDuel's");
  assert.equal(built.lines.total, 51.5);
  // So FanDuel's under 52.5 is priced as the better bet it is: a point above the market.
  const under = built.legs.find((l) => l.market === "total")!;
  assert.equal(under.line, 52.5);
});

test("a leg at a better number than the market is priced as better", () => {
  const atMarket = priceSameGame(margin(), score(), { homeSpread: -3.5, total: 52.5 }, [
    { market: "total", side: "under", line: 52.5 },
    { market: "spread", side: "home", line: -3.5 },
  ])!;
  const pointBetter = priceSameGame(margin(), score(), { homeSpread: -3.5, total: 51.5 }, [
    { market: "total", side: "under", line: 52.5 },
    { market: "spread", side: "home", line: -3.5 },
  ])!;
  assert.ok(pointBetter.win > atMarket.win, `${pointBetter.win} vs ${atMarket.win}`);
});

test("a stale quote is never part of the reference", () => {
  const rows = [
    boardRow({ book: "FanDuel", market: "spread", side: "home", line: -4 }),
    boardRow({ book: "FanDuel", market: "total", side: "over", line: 45.5 }),
    boardRow({ book: "Caesars", market: "spread", side: "home", line: -4 }),
    boardRow({ book: "Stale", market: "spread", side: "home", line: -20, stale: true } as never),
  ];
  const [built] = sgpGamesFromBoard(rows);
  assert.equal(built.lines.homeSpread, -4);
});

test("only my books are considered when I say which I hold", () => {
  const rows = [
    boardRow({ book: "Caesars", market: "spread", side: "home" }),
    boardRow({ book: "Caesars", market: "total", side: "over", line: 45.5 }),
  ];
  assert.deepEqual(sgpGamesFromBoard(rows, { books: ["FanDuel"] }), []);
  assert.equal(sgpGamesFromBoard(rows, { books: ["Caesars"] }).length, 1);
  // No list means no filter, rather than no books.
  assert.equal(sgpGamesFromBoard(rows, { books: [] }).length, 1);
});

// --- the Titans ticket, which reached the top of the page ------------------------

test("a ticket whose legs imply each other is refused", () => {
  // Tennessee Titans ML + Titans +6 + Titans +6.5, ranked first by the old statistic.
  // Winning outright covers both spreads, so the three legs are one bet written three
  // times -- and the book charges for three.
  const legs: ScoreLeg[] = [
    { market: "moneyline", side: "away" },
    { market: "spread", side: "away", line: 6 },
    { market: "spread", side: "away", line: 6.5 },
  ];
  const lines = { homeSpread: -6, total: 44.5 };
  const joint = jointProbability(margin(), score(), lines, legs)!;
  const mlOnly = jointProbability(margin(), score(), lines, [legs[0]])!;
  assert.ok(
    Math.abs(joint.win - mlOnly.win) < 1e-9,
    "the ticket is exactly the moneyline; if this drifts the premise is gone",
  );
  assert.equal(everyLegEarnsItsPlace(margin(), score(), lines, legs), false);
});

test("legs that each change the ticket are kept", () => {
  assert.equal(
    everyLegEarnsItsPlace(margin(), score(), LINES, [
      { market: "spread", side: "home", line: -3.5 },
      { market: "total", side: "over", line: 45.5 },
    ]),
    true,
  );
});

test("a near-duplicate is refused too, not just an exact one", () => {
  // +6 and +7 on one side differ by a fraction of a percent and cost a whole leg's
  // markup for it.
  assert.equal(
    everyLegEarnsItsPlace(margin(), score(), { homeSpread: -6.5, total: 44.5 }, [
      { market: "spread", side: "away", line: 6 },
      { market: "spread", side: "away", line: 7 },
    ]),
    false,
  );
});

test("the reference line comes from the legs, not from a separate snapshot", () => {
  // The bug behind the 40%: legs said +6 while the board said about -3, so the game was
  // centred three points from where it was actually priced and a 31% ticket read 40%.
  const rows = [
    boardRow({ market: "spread", side: "away", line: 6, gameSpread: -3 }),
    boardRow({ market: "spread", side: "home", line: -6, gameSpread: -3 }),
    boardRow({ market: "total", side: "over", line: 44.5, gameSpread: -3 }),
    boardRow({ market: "total", side: "under", line: 44.5, gameSpread: -3 }),
  ];
  const [built] = sgpGamesFromBoard(rows);
  assert.equal(built.lines.homeSpread, -6, "the legs' own number, not the stale board's");
  assert.equal(built.lines.total, 44.5);
});

test("an away spread is read as the home handicap it is", () => {
  const [built] = sgpGamesFromBoard([
    boardRow({ market: "spread", side: "away", line: 7, gameSpread: null }),
    boardRow({ market: "total", side: "over", line: 44.5, gameSpread: null }),
  ]);
  // Away +7 is the same game as home -7. Reading it literally would flip the favourite.
  assert.equal(built.lines.homeSpread, -7);
});

test("a leg that does not beat its own price keeps the ticket off the page", () => {
  const board = game([
    { ...priced("spread", "home", -3.5, -110), edgePoints: 2.5 },
    { ...priced("total", "over", 45.5, -110), edgePoints: 0.2 },
  ]);
  assert.deepEqual(
    bestSameGameParlays([board], MARGINS, SCORES, { minEdgePoints: 1.5, maxLegs: 2 }),
    [],
  );
  assert.equal(
    bestSameGameParlays([board], MARGINS, SCORES, { minEdgePoints: 0, maxLegs: 2 }).length,
    1,
  );
});

test("tickets are ranked by their legs' measured edge, not by the correlation gap", () => {
  // The old statistic ranked on how far the book could mark the ticket down from the
  // product of its legs -- a gap that is widest exactly when the legs are most
  // redundant, so it sorted the least informative ticket to the top.
  const weak = game([
    { ...priced("spread", "home", -3.5, -110), edgePoints: 1.6 },
    { ...priced("total", "over", 45.5, -110), edgePoints: 1.6 },
  ]);
  const strong: SgpGame = {
    ...game([
      { ...priced("spread", "home", -3.5, -110), edgePoints: 4.0 },
      { ...priced("total", "over", 45.5, -110), edgePoints: 3.5 },
    ]),
    eventId: "g2",
  };
  const picks = bestSameGameParlays([weak, strong], MARGINS, SCORES, {
    minEdgePoints: 1.5, maxLegs: 2, limit: 5,
  });
  assert.equal(picks[0].game.eventId, "g2");
});

// --- never against your own team -------------------------------------------------

test("a same-game leg against your team never joins a ticket", () => {
  const rows = [
    boardRow({ market: "spread", side: "home", line: -3.5 }),
    boardRow({ market: "spread", side: "away", line: 3.5 }),
    boardRow({ market: "moneyline", side: "away", line: null, price: 150 }),
    boardRow({ market: "total", side: "over", line: 44.5 }),
  ];
  const [built] = sgpGamesFromBoard(rows, { favourites: ["Home"] });
  const sides = built.legs.map((leg) => `${leg.market}:${leg.side}`);
  assert.ok(!sides.includes("spread:away"), sides.join(", "));
  assert.ok(!sides.includes("moneyline:away"), sides.join(", "));
  // Backing them and the total are untouched.
  assert.ok(sides.includes("spread:home"));
  assert.ok(sides.includes("total:over"));
});

test("skipping a side does not move the line the game is priced at", () => {
  // What the game is priced at does not depend on which side you would bet, so the
  // reference must come from every row, including the skipped ones.
  const rows = [
    boardRow({ market: "spread", side: "home", line: -7 }),
    boardRow({ market: "spread", side: "away", line: 7 }),
    boardRow({ market: "total", side: "over", line: 44.5 }),
  ];
  const [withRule] = sgpGamesFromBoard(rows, { favourites: ["Home"] });
  const [without] = sgpGamesFromBoard(rows);
  assert.equal(withRule.lines.homeSpread, without.lines.homeSpread);
});
