import { test } from "node:test";
import assert from "node:assert/strict";

import {
  asOf,
  betName,
  clampLimit,
  easternDate,
  fraction,
  freshnessLine,
  meetsMinOdds,
  parseDate,
  parseLeague,
  quoteSeenAt,
  resolveBook,
} from "./mcp-format.ts";

const NOW = new Date("2026-10-25T18:00:00Z");

test("a price over ten minutes old is stale; a missing stamp is too", () => {
  assert.deepEqual(asOf("2026-10-25T17:55:00Z", NOW), { as_of: "2026-10-25T17:55:00.000Z", stale: false });
  assert.equal(asOf("2026-10-25T17:49:00Z", NOW).stale, true);
  assert.deepEqual(asOf(null, NOW), { as_of: null, stale: true });
  assert.equal(asOf("garbage", NOW).stale, true);
});

test("dates are Eastern: a Saturday 11pm ET kickoff is Saturday, not Sunday UTC", () => {
  assert.equal(easternDate("2026-10-25T03:00:00Z"), "2026-10-24");
  assert.equal(parseDate("today", NOW), "2026-10-25");
  assert.equal(parseDate("tomorrow", NOW), "2026-10-26");
  assert.equal(parseDate("2026-10-31", NOW), "2026-10-31");
  assert.equal(parseDate("next week", NOW), "bad");
  assert.equal(parseDate(undefined, NOW), null);
});

test("sports and books are matched loosely but never ambiguously", () => {
  assert.equal(parseLeague("NFL"), "nfl");
  assert.equal(parseLeague("CFB"), "ncaaf");
  assert.equal(parseLeague("NCAAF"), "ncaaf");
  assert.equal(parseLeague("NBA"), "bad");
  const books = ["BetMGM", "BetRivers", "DraftKings", "FanDuel", "BetOnline.ag"];
  assert.equal(resolveBook("fanduel", books), "FanDuel");
  assert.equal(resolveBook("Fan Duel", books), "FanDuel");
  assert.equal(resolveBook("betonline", books), "BetOnline.ag");
  assert.equal(resolveBook("bet", books), null); // three books start with "bet"
  assert.equal(resolveBook("Caesars", books), null);
});

test("a boost or tax rate reads the same typed as 30 or 0.3", () => {
  assert.equal(fraction(30), 0.3);
  assert.equal(fraction(0.3), 0.3);
  assert.equal(fraction(100), 1);
  assert.equal(fraction(1), 1);
  assert.equal(fraction(-5), null);
  assert.equal(fraction(undefined), null);
});

test("minimum odds compare by payout, so -150 meets a -200 minimum and -250 does not", () => {
  assert.equal(meetsMinOdds(-150, -200), true);
  assert.equal(meetsMinOdds(-200, -200), true);
  assert.equal(meetsMinOdds(-250, -200), false);
  assert.equal(meetsMinOdds(120, -200), true);
  assert.equal(meetsMinOdds(110, 150), false);
  assert.equal(meetsMinOdds(-110, undefined), true);
});

test("bets are named the way a slip names them", () => {
  const game = { homeTeam: "Detroit Lions", awayTeam: "Green Bay Packers" };
  assert.equal(betName("spread", "home", -2.5, game), "Detroit Lions -2.5");
  assert.equal(betName("spread", "away", 2.5, game), "Green Bay Packers +2.5");
  assert.equal(betName("moneyline", "home", null, game), "Detroit Lions ML");
  assert.equal(betName("total", "over", 47.5, game), "Over 47.5");
});

test("DraftKings is timed by the board; other books by their own row", () => {
  const game = { lastObserved: "2026-10-25T17:58:00Z" };
  const stored = [
    { book: "FanDuel", market: "spread", side: "home", observed_at: "2026-10-25T17:40:00Z" },
  ] as never[];
  assert.equal(quoteSeenAt(game, stored, "DraftKings", "spread", "home"), "2026-10-25T17:58:00Z");
  assert.equal(quoteSeenAt(game, stored, "FanDuel", "spread", "home"), "2026-10-25T17:40:00Z");
  assert.equal(quoteSeenAt(game, stored, "FanDuel", "spread", "away"), null);
});

test("the freshness line says how many prices are old", () => {
  assert.equal(freshnessLine([{ as_of: "x", stale: false }], NOW), "All prices under 10 min old.");
  assert.match(
    freshnessLine([{ as_of: "2026-10-25T17:00:00Z", stale: true }, { as_of: "2026-10-25T17:55:00Z", stale: false }], NOW),
    /^1 of 2 prices are over 10 min old \(newest 5 min ago\)/,
  );
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit(100), 25);
  assert.equal(clampLimit(0), 10);
});
