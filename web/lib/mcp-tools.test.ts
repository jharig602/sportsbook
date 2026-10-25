import { test } from "node:test";
import assert from "node:assert/strict";

import type { BookLineRow } from "./book-lines.ts";
import { getData } from "./data.ts";
import { findBonusBetSpots, findBoostSpots, getGame, getShop, matchGames, ToolInputError, type Market_, type ToolDeps } from "./mcp-tools.ts";
import type { Game } from "./types.ts";

// One NFL game priced at seven books. FanDuel hangs the Lions a point better than
// everyone else; Bovada (offshore) hangs them better still.
const NOW = new Date("2026-10-25T15:00:00Z");
const GAME: Game = {
  eventId: "g1",
  league: "nfl",
  commenceTime: "2026-10-25T20:25:00Z",
  homeTeam: "Detroit Lions",
  awayTeam: "Green Bay Packers",
  homeTeamId: null,
  awayTeamId: null,
  lastObserved: "2026-10-25T14:57:00Z",
  spread: { home: { line: -2.5, price: -110 }, away: { line: 2.5, price: -110 } },
  total: { over: { line: 47.5, price: -110 }, under: { line: 47.5, price: -110 } },
  moneyline: { home: { line: null, price: -140 }, away: { line: null, price: 120 } },
};

function book(name: string, homeSpread: number, seen: string, ml: [number, number] = [-140, 120]): BookLineRow[] {
  const row = (market: BookLineRow["market"], side: BookLineRow["side"], line: number | null, price: number): BookLineRow => ({
    quote_id: `${name}-${market}-${side}`,
    observed_at: seen,
    league: "nfl",
    event_id: "g1",
    book: name,
    market,
    side,
    line,
    price,
    source: "test",
    note: null,
  });
  return [
    row("spread", "home", homeSpread, -110),
    row("spread", "away", -homeSpread, -110),
    row("total", "over", 47.5, -110),
    row("total", "under", 47.5, -110),
    row("moneyline", "home", null, ml[0]),
    row("moneyline", "away", null, ml[1]),
  ];
}

async function deps(): Promise<ToolDeps> {
  const data = getData();
  const lines = new Map<string, BookLineRow[]>([
    [
      "g1",
      [
        ...book("FanDuel", -1.5, "2026-10-25T14:56:00Z", [-125, 105]),
        ...book("BetMGM", -2.5, "2026-10-25T14:30:00Z"),
        ...book("Caesars", -2.5, "2026-10-25T14:30:00Z"),
        ...book("BetRivers", -2.5, "2026-10-25T14:30:00Z"),
        ...book("ESPN BET", -2.5, "2026-10-25T14:30:00Z"),
        ...book("Fanatics", -2.5, "2026-10-25T14:30:00Z"),
        ...book("Bovada", -1.0, "2026-10-25T14:30:00Z"),
      ],
    ],
  ]);
  const market: Market_ = {
    games: [GAME],
    lines,
    models: await data.marginModels(),
    scoreModels: await data.scoreModels(),
    lastRun: null,
  };
  return {
    market,
    settings: { tax: { rate: 0.2625, losses: "none", state: 0.0425 }, favourites: [] },
    openEvents: new Set(),
  };
}

test("get_shop finds the licensed outlier, flags old prices, and leaves offshore out", async () => {
  const d = await deps();
  const answer = await getShop({}, NOW, d);
  const rows = (answer.data as { rows: Array<Record<string, unknown>> }).rows;
  assert.ok(rows.length > 0, answer.summary);
  assert.equal(rows.some((r) => r.book === "Bovada"), false, "offshore excluded by default");
  const top = rows[0];
  assert.equal(top.book, "FanDuel");
  assert.equal(top.bet, "Detroit Lions -1.5");
  assert.ok((top.edge_pct as number) > 0);
  assert.ok((top.books_compared as number) >= 6);
  assert.equal(top.stale, false, "FanDuel was seen 4 minutes ago");
  assert.match(answer.summary, /FanDuel Detroit Lions -1\.5/);

  // Asking for an offshore book by name is a deliberate choice and is honoured.
  const bovada = await getShop({ book: "bovada" }, NOW, d);
  const bRows = (bovada.data as { rows: Array<Record<string, unknown>> }).rows;
  assert.ok(bRows.length > 0 && bRows.every((r) => r.book === "Bovada"));
  assert.equal(bRows[0].stale, true, "seen 30 minutes ago");

  // min_books above the field leaves nothing, and says why.
  const thin = await getShop({ min_books: 20 }, NOW, d);
  assert.match(thin.summary, /fewer than|with 20\+ books/);
});

test("get_shop refuses a sport or book it does not know, plainly", async () => {
  const d = await deps();
  await assert.rejects(getShop({ sport: "NBA" }, NOW, d), ToolInputError);
  await assert.rejects(getShop({ book: "Pinnacle" }, NOW, d), /No prices from "Pinnacle"/);
});

test("find_boost_spots ranks FanDuel's lines by after-tax value with the boosted price", async () => {
  const d = await deps();
  const answer = await findBoostSpots({ book: "fanduel", boost_pct: 30, max_wager: 25 }, NOW, d);
  const data = answer.data as { rows: Array<Record<string, number | string | boolean>>; tax_rate_pct: number; boost_pct: number };
  assert.equal(data.boost_pct, 30);
  assert.equal(data.tax_rate_pct, 26.25);
  assert.ok(data.rows.length > 0, answer.summary);
  for (let i = 1; i < data.rows.length; i += 1) {
    assert.ok((data.rows[i - 1].ev_after_tax as number) >= (data.rows[i].ev_after_tax as number));
  }
  const ml = data.rows.find((r) => r.bet === "Green Bay Packers ML");
  assert.ok(ml, "the underdog moneyline is ranked");
  assert.equal(ml!.price, 105);
  assert.equal(ml!.boosted_price, 137); // +105 with 30% more profit pays +136.5, logged +137
  // The same line as a fraction reads the same.
  const again = await findBoostSpots({ book: "FanDuel", boost_pct: 0.3, max_wager: 25 }, NOW, d);
  assert.deepEqual((again.data as { rows: unknown[] }).rows, data.rows);
  // A minimum of -120 drops the -125 favourite.
  const capped = await findBoostSpots({ book: "FanDuel", boost_pct: 30, max_wager: 25, min_odds: -120 }, NOW, d);
  assert.equal((capped.data as { rows: Array<{ bet: string }> }).rows.some((r) => r.bet === "Detroit Lions ML"), false);
});

test("find_bonus_bet_spots values a bonus bet in cash and skips games already bet", async () => {
  const d = await deps();
  const answer = await findBonusBetSpots({ book: "FanDuel", amount: 10 }, NOW, d);
  const rows = (answer.data as { rows: Array<Record<string, number | string>> }).rows;
  assert.ok(rows.length > 0, answer.summary);
  assert.ok((rows[0].value_after_tax as number) > 0 && (rows[0].value_after_tax as number) < 10);
  const skipped = await findBonusBetSpots({ book: "FanDuel", amount: 10 }, NOW, { ...d, openEvents: new Set(["g1"]) });
  assert.equal((skipped.data as { rows: unknown[] }).rows.length, 0);
  assert.match(skipped.summary, /games you already have money on were skipped/);
});

test("get_game finds a team by any part of its name and prices every side", async () => {
  const d = await deps();
  const answer = await getGame({ query: "lions" }, NOW, d);
  const data = answer.data as {
    game: string;
    sides: Array<Record<string, unknown>>;
    books: Array<Record<string, unknown>>;
    best_prices: Array<Record<string, unknown>>;
    model_basis: { fitted_on_games?: number };
  };
  assert.equal(data.game, "Green Bay Packers @ Detroit Lions");
  assert.equal(data.sides.length, 6);
  const home = data.sides.find((s) => s.bet === "Detroit Lions -2.5")!;
  assert.ok(typeof home.market_prob === "number");
  assert.ok(typeof home.boost_needed_after_tax_pct === "number");
  assert.equal(data.books.some((b) => b.book === "Bovada"), false);
  assert.equal(data.best_prices[0].book, "FanDuel");
  assert.ok((data.model_basis.fitted_on_games ?? 0) > 0);
  await assert.rejects(getGame({ query: "Steelers" }, NOW, d), /No upcoming game/);
  await assert.rejects(getGame({}, NOW, d), ToolInputError);
});

test("team matching: a nickname, a city, or the id; past games drop off", () => {
  assert.equal(matchGames([GAME], "Packers", undefined, NOW).length, 1);
  assert.equal(matchGames([GAME], "green bay", undefined, NOW).length, 1);
  assert.equal(matchGames([GAME], undefined, "g1", NOW).length, 1);
  assert.equal(matchGames([GAME], "Lions", undefined, new Date("2026-10-27T00:00:00Z")).length, 0);
});
