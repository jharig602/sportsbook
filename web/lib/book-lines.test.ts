import assert from "node:assert/strict";
import { test } from "node:test";

import { quotesForGame, type BookLineRow } from "./book-lines.ts";
import { shopAll } from "./shop.ts";
import type { MarginModel } from "./probability.ts";
import type { Game } from "./types.ts";

const NFL: MarginModel = { league: "nfl", games: 291, mean: 0.35, sd: 12.32, pmf: {} };

const GAME: Game = {
  eventId: "401",
  league: "nfl",
  commenceTime: "2026-09-13T17:00:00Z",
  homeTeam: "Houston Texans",
  awayTeam: "Chicago Bears",
  homeTeamId: "34",
  awayTeamId: "3",
  lastObserved: "2026-09-12T12:00:00Z",
  spread: { home: { line: -1.5, price: 102 }, away: { line: 1.5, price: -122 } },
  total: { over: { line: 44.5, price: -110 }, under: { line: 44.5, price: -110 } },
  moneyline: { home: { line: null, price: -125 }, away: { line: null, price: 105 } },
};

function row(over: Partial<BookLineRow>): BookLineRow {
  return {
    quote_id: "q1",
    observed_at: "2026-09-12T13:00:00Z",
    league: "nfl",
    event_id: "401",
    book: "BetMGM",
    market: "spread",
    side: "home",
    line: -1,
    price: -110,
    source: "manual",
    note: null,
    ...over,
  } as BookLineRow;
}

test("the board's own book is derived, not stored", () => {
  const quotes = quotesForGame(GAME, []);
  const books = new Set(quotes.map((q) => q.book));
  assert.deepEqual([...books], ["DraftKings"]);
  // Six quotes: two sides each of spread, total and moneyline.
  assert.equal(quotes.length, 6);
});

test("the opposite price is attached so each quote can be de-vigged", () => {
  const quotes = quotesForGame(GAME, []);
  const homeSpread = quotes.find((q) => q.market === "spread" && q.side === "home")!;
  assert.equal(homeSpread.price, 102);
  assert.equal(homeSpread.oppositePrice, -122);
});

test("a moneyline carries no line, only a price", () => {
  const quotes = quotesForGame(GAME, []);
  const ml = quotes.find((q) => q.market === "moneyline" && q.side === "home")!;
  assert.equal(ml.line, null);
  assert.equal(ml.price, -125);
});

test("a stored book joins the comparison", () => {
  const quotes = quotesForGame(GAME, [row({}), row({ quote_id: "q2", side: "away", line: 1 })]);
  assert.equal(quotes.filter((q) => q.book === "BetMGM").length, 2);
  const mgm = quotes.find((q) => q.book === "BetMGM" && q.side === "home")!;
  assert.equal(mgm.line, -1);
  assert.equal(mgm.oppositePrice, -110);
});

test("a stored row claiming to be the feed's book cannot shadow the snapshot", () => {
  // Otherwise DraftKings would be compared against DraftKings, whose gap is zero by
  // construction, and the real book's number would vanish from the board.
  const quotes = quotesForGame(GAME, [row({ book: "DraftKings", line: -7 })]);
  const dk = quotes.filter((q) => q.book === "DraftKings" && q.market === "spread" && q.side === "home");
  assert.equal(dk.length, 1);
  assert.equal(dk[0].line, -1.5, "the snapshot wins");
});

test("the real case end to end: DK -1.5 juiced against MGM -1", () => {
  // The line the user actually checked by hand. DK posts -1.5 but charges +102/-122
  // for it; MGM posts -1 at -110. The gap is half a point of posted line.
  const rows = shopAll(quotesForGame(GAME, [row({}), row({ quote_id: "q2", side: "away", line: 1 })]), NFL);
  const mgm = rows.find((r) => r.book === "BetMGM" && r.market === "spread" && r.side === "home")!;
  assert.equal(mgm.consensusLine, -1.5);
  assert.equal(mgm.advantagePoints, 0.5);
  // Half a point is real and in MGM's favour, and still does not cover the hold —
  // which is what the hand check found.
  assert.ok(mgm.expectedRoi! < 0);
  assert.ok(mgm.expectedRoi! > -0.03, "but it is markedly better than the -4.5% baseline");
});

test("a genuinely stale second book shows up as positive return", () => {
  const rows = shopAll(
    quotesForGame(GAME, [
      row({ line: 0.5, price: -110 }),
      row({ quote_id: "q2", side: "away", line: -0.5, price: -110 }),
    ]),
    NFL,
  );
  const mgm = rows.find((r) => r.book === "BetMGM" && r.market === "spread" && r.side === "home")!;
  assert.equal(mgm.advantagePoints, 2);
  assert.ok(mgm.expectedRoi! > 0);
  // And the board's ranking puts it first without being told to.
  assert.equal(rows[0].book, "BetMGM");
});

test("a missing game still prices stored books against each other", () => {
  const rows = shopAll(
    quotesForGame(undefined, [
      row({ book: "BetMGM", line: -1 }),
      row({ quote_id: "q2", book: "Caesars", line: -3 }),
    ]),
    NFL,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.book === "BetMGM")!.advantagePoints, 2);
});

test("sides with neither line nor price are skipped, not quoted as null", () => {
  const bare: Game = { ...GAME, total: { over: { line: null, price: null } }, moneyline: {} };
  const quotes = quotesForGame(bare, []);
  assert.equal(quotes.length, 2);
  assert.ok(quotes.every((q) => q.market === "spread"));
});
