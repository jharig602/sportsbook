import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBoardShop } from "./board-shop.ts";
import type { BookLineRow } from "./book-lines.ts";
import type { MarginModel } from "./probability.ts";
import type { Game } from "./types.ts";

const NOW = new Date("2026-09-12T13:00:00Z");
const MODELS: Record<string, MarginModel> = {
  nfl: { league: "nfl", games: 2215, mean: -0.19, sd: 12.74, pmf: {} },
  ncaaf: { league: "ncaaf", games: 6142, mean: 0.26, sd: 15.43, pmf: {} },
};

function game(over: Partial<Game> = {}): Game {
  return {
    eventId: "401",
    league: "nfl",
    commenceTime: "2026-09-13T17:00:00Z",
    homeTeam: "Houston Texans",
    awayTeam: "Chicago Bears",
    homeTeamId: "34",
    awayTeamId: "3",
    lastObserved: "2026-09-12T12:45:00Z",
    spread: { home: { line: -3, price: -110 }, away: { line: 3, price: -110 } },
    total: {},
    moneyline: {},
    ...over,
  };
}

function line(over: Partial<BookLineRow> = {}): BookLineRow {
  return {
    quote_id: "q1",
    observed_at: "2026-09-12T12:50:00Z",
    league: "nfl",
    event_id: "401",
    book: "BetMGM",
    market: "spread",
    side: "home",
    line: -3,
    price: -110,
    source: "oddsapi",
    note: null,
    ...over,
  } as BookLineRow;
}

/** Three books agreeing at `at`, so the board's consensus floor is satisfied. */
function field(at: number, event = "401", league: "nfl" | "ncaaf" = "nfl"): BookLineRow[] {
  return ["FanDuel", "Caesars", "BetRivers"].flatMap((book, i) => [
    line({ quote_id: `f${event}${i}h`, book, event_id: event, league, side: "home", line: at }),
    line({ quote_id: `f${event}${i}a`, book, event_id: event, league, side: "away", line: -at }),
  ]);
}

function lines(rows: BookLineRow[]): Map<string, BookLineRow[]> {
  const map = new Map<string, BookLineRow[]>();
  for (const row of rows) {
    const bucket = map.get(row.event_id);
    if (bucket) bucket.push(row);
    else map.set(row.event_id, [row]);
  }
  return map;
}

test("a game with no second book contributes nothing", () => {
  const shop = buildBoardShop([game()], new Map(), MODELS, NOW);
  assert.equal(shop.gamesWithSecondBook, 0);
  assert.equal(shop.rows.length, 0);
  assert.equal(shop.best, null);
});

test("a game with a full field of books is compared and counted", () => {
  const shop = buildBoardShop([game()], lines([line(), ...field(-3)]), MODELS, NOW);
  assert.equal(shop.gamesWithSecondBook, 1);
  assert.deepEqual(shop.books, ["BetMGM", "BetRivers", "Caesars", "DraftKings", "FanDuel"]);
  assert.ok(shop.rows.length > 0);
});

test("a game with only one other book is not ranked on the board", () => {
  // It is still priced on the game page; the board refuses because mining sixty games
  // for the largest number would select exactly these thin references.
  const shop = buildBoardShop([game()], lines([line({ line: -1 })]), MODELS, NOW);
  assert.equal(shop.gamesWithSecondBook, 1, "the game is still counted as compared");
  assert.equal(shop.positive.length, 0, "but no return is quoted from two opinions");
});

test("a genuine one-point gap surfaces and beats the vig", () => {
  const shop = buildBoardShop(
    [game()],
    lines([line({ line: -2 }), line({ quote_id: "q2", side: "away", line: 2 }), ...field(-3)]),
    MODELS,
    NOW,
  );
  assert.equal(shop.positive.length > 0, true);
  assert.equal(shop.best!.book, "BetMGM");
  assert.equal(shop.best!.advantagePoints, 1);
  assert.ok(shop.best!.expectedRoi! > 0);
});

test("an agreeing board produces rows at the hold, and nothing positive", () => {
  const shop = buildBoardShop([game()], lines([line(), ...field(-3)]), MODELS, NOW);
  assert.equal(shop.positive.length, 0);
  // Which is the correct reading, not an empty page: the closest is still shown.
  assert.ok(shop.best !== null);
  assert.ok(Math.abs(shop.best!.expectedRoi! + 0.0454) < 0.002);
});

test("games already under way are excluded", () => {
  const started = game({ commenceTime: "2026-09-12T12:00:00Z" });
  const shop = buildBoardShop([started], lines([line()]), MODELS, NOW);
  assert.equal(shop.gamesWithSecondBook, 0, "a gap on a running game is history");
});

test("a stale second book does not count as a second book", () => {
  const shop = buildBoardShop(
    [game()],
    lines([line({ observed_at: "2026-09-09T12:00:00Z", line: -2 })]),
    MODELS,
    NOW,
  );
  assert.equal(shop.gamesWithSecondBook, 0);
  assert.equal(shop.rows.length, 0, "and it certainly does not manufacture an edge");
});

test("rows are ranked by return across every game, not within one", () => {
  const small = game();
  const big = game({
    eventId: "402",
    league: "ncaaf",
    homeTeam: "Michigan Wolverines",
    awayTeam: "Oklahoma Sooners",
    commenceTime: "2026-09-13T20:00:00Z",
  });
  const shop = buildBoardShop(
    [small, big],
    lines([
      line({ line: -3.5 }),
      line({ quote_id: "q2", side: "away", line: 3.5 }),
      ...field(-3),
      line({ quote_id: "q3", event_id: "402", league: "ncaaf", line: -1 }),
      line({ quote_id: "q4", event_id: "402", league: "ncaaf", side: "away", line: 1 }),
      ...field(-3, "402", "ncaaf"),
    ]),
    MODELS,
    NOW,
  );
  // The 2-point college gap outranks the half-point NFL one, across games.
  assert.equal(shop.best!.eventId, "402");
  assert.equal(shop.best!.advantagePoints, 2);
  assert.equal(shop.gamesWithSecondBook, 2);
  const returns = shop.rows.map((r) => r.expectedRoi ?? -Infinity);
  assert.deepEqual(returns, [...returns].sort((a, b) => b - a));
});

test("each row carries enough to render and link without another lookup", () => {
  const shop = buildBoardShop([game()], lines([line({ line: -2 }), ...field(-3)]), MODELS, NOW);
  const row = shop.best!;
  assert.equal(row.eventId, "401");
  assert.equal(row.homeTeam, "Houston Texans");
  assert.equal(row.awayTeam, "Chicago Bears");
  assert.equal(row.league, "nfl");
  assert.equal(row.commenceTime, "2026-09-13T17:00:00Z");
});

test("the right league's model prices the gap", () => {
  // Same one-point gap, different leagues: college points are worth less, because the
  // outcome distribution is wider.
  const nfl = buildBoardShop(
    [game()],
    lines([line({ line: -2 }), line({ quote_id: "q2", side: "away", line: 2 }), ...field(-3)]),
    MODELS,
    NOW,
  );
  const college = buildBoardShop(
    [game({ eventId: "402", league: "ncaaf" })],
    lines([
      line({ event_id: "402", league: "ncaaf", line: -2 }),
      line({ quote_id: "q2", event_id: "402", league: "ncaaf", side: "away", line: 2 }),
      ...field(-3, "402", "ncaaf"),
    ]),
    MODELS,
    NOW,
  );
  assert.ok(nfl.best!.expectedRoi! > college.best!.expectedRoi!);
});

test("an empty board is not an error", () => {
  const shop = buildBoardShop([], new Map(), MODELS, NOW);
  assert.deepEqual(shop.rows, []);
  assert.equal(shop.best, null);
  assert.equal(shop.books.length, 0);
});
