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
import type { ScoreModel } from "./joint-score.ts";
import type { MarginModel } from "./probability.ts";
import {
  type PricedLeg,
  type SgpGame,
  bestSameGameParlays,
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

test("the best price for a leg wins, across books", () => {
  const games = sgpGamesFromBoard([
    boardRow({ book: "FanDuel", market: "spread", side: "home", price: -115 }),
    boardRow({ book: "DraftKings", market: "spread", side: "home", price: -105 }),
    boardRow({ market: "total", side: "over", line: 45.5, price: -110 }),
  ]);
  assert.equal(games.length, 1);
  const spread = games[0].legs.find((l) => l.market === "spread")!;
  assert.equal(spread.price, -105, "the price actually available is the one that decides");
});

test("two books on different numbers stay different bets", () => {
  // Collapsing them would quote one book's price at the other's line, which is a bet
  // nobody is offering.
  const games = sgpGamesFromBoard([
    boardRow({ book: "FanDuel", market: "spread", side: "home", line: -3.5 }),
    boardRow({ book: "DraftKings", market: "spread", side: "home", line: -3 }),
    boardRow({ market: "total", side: "over", line: 45.5 }),
  ]);
  const lines = games[0].legs
    .filter((l) => l.market === "spread")
    .map((l) => l.line as number)
    .sort((a, b) => a - b);
  assert.deepEqual(lines, [-3.5, -3]);
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
