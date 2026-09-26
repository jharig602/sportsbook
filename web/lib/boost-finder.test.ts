import assert from "node:assert/strict";
import { test } from "node:test";

import type { BookLineRow } from "./book-lines.ts";
import { evPerDollar, findBoosts, totalChances } from "./boost-finder.ts";
import type { ScoreModel } from "./joint-score.ts";
import type { Game } from "./types.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const KICK = "2026-09-26T17:00:00Z";
const SCORE: ScoreModel = { league: "ncaaf", games: 5000, totalMean: 0.6, totalSd: 16, marginMean: 0, marginSd: 15, correlation: 0 };

function game(over: Partial<Game> = {}): Game {
  return {
    eventId: "G", league: "ncaaf", commenceTime: KICK, homeTeam: "Kentucky Wildcats", awayTeam: "South Alabama Jaguars",
    homeTeamId: null, awayTeamId: null, lastObserved: "2026-09-26T11:00:00Z",
    spread: { home: { line: -6.5, price: -110 }, away: { line: 6.5, price: -110 } },
    total: { over: { line: 54.5, price: -110 }, under: { line: 54.5, price: -110 } },
    moneyline: { home: { line: null, price: -240 }, away: { line: null, price: 195 } },
    ...over,
  } as Game;
}

function row(book: string, market: string, side: string, line: number | null, price: number): BookLineRow {
  return { quote_id: `${book}${market}${side}`, observed_at: "2026-09-26T11:30:00Z", league: "ncaaf", event_id: "G",
    book, market, side, line, price, source: "oddsapi", note: null } as BookLineRow;
}

/** FanDuel plus two other books, all at 54.5 -110 both ways. */
function stored(fanduelLine = 54.5): Map<string, BookLineRow[]> {
  return new Map([["G", [
    row("FanDuel", "total", "over", fanduelLine, -110), row("FanDuel", "total", "under", fanduelLine, -110),
    row("BetMGM", "total", "over", 54.5, -110), row("BetMGM", "total", "under", 54.5, -110),
    row("Caesars", "total", "over", 54.5, -110), row("Caesars", "total", "under", 54.5, -110),
  ]]]);
}

const OPTS = { book: "FanDuel", boost: 0.5, stake: 10, maxSpread: 28, now: NOW };

test("at the same number and price, the over outranks the under: finals land a little over", () => {
  const { checked } = findBoosts([game()], stored(), {}, { ncaaf: SCORE }, OPTS);
  const over = checked.find((p) => p.label === "Over 54.5")!;
  const under = checked.find((p) => p.label === "Under 54.5")!;
  assert.ok(over.win > 0.5 && under.win < 0.5);
  assert.ok(over.boosted > under.boosted);
  assert.ok(checked.indexOf(over) < checked.indexOf(under));
  // A 50% boost at -110 turns a small loser into a clear winner.
  assert.ok(over.plain < 0 && over.boosted > 0);
});

test("a better number at the book outweighs the lean: a point on the under beats the over", () => {
  const { checked } = findBoosts([game()], stored(56.5), {}, { ncaaf: SCORE }, OPTS);
  const over = checked.find((p) => p.label === "Over 56.5")!;
  const under = checked.find((p) => p.label === "Under 56.5")!;
  assert.ok(under.boosted > over.boosted);
});

test("a total far off the other books is listed apart, not ranked as a gift", () => {
  const { checked, unchecked } = findBoosts([game()], stored(62.5), {}, { ncaaf: SCORE }, OPTS);
  assert.ok(!checked.some((p) => p.market === "total"));
  assert.ok(unchecked.some((p) => p.label === "Under 62.5"));
});

test("a whole-number total can push, and a push is the stake back, not a loss", () => {
  const { win, push } = totalChances("over", 54, 54.6, 16);
  assert.ok(push > 0.015 && push < 0.03);
  assert.ok(Math.abs(evPerDollar(win, push, -110, 0) - (win * (100 / 110) - (1 - win - push))) < 1e-12);
});

test("a moneyline against one of your teams is never suggested", () => {
  const lines = new Map([["G", [
    row("FanDuel", "moneyline", "home", null, -240), row("FanDuel", "moneyline", "away", null, 195),
    row("BetMGM", "moneyline", "home", null, -250), row("BetMGM", "moneyline", "away", null, 200),
    row("Caesars", "moneyline", "home", null, -245), row("Caesars", "moneyline", "away", null, 198),
  ]]]);
  const all = findBoosts([game()], lines, {}, {}, OPTS).checked.map((p) => p.label);
  assert.ok(all.includes("South Alabama Jaguars ML"));
  const fan = findBoosts([game()], lines, {}, {}, { ...OPTS, favourites: ["Kentucky Wildcats"] }).checked.map((p) => p.label);
  assert.ok(!fan.includes("South Alabama Jaguars ML"), "backing their opponent is against your team");
  assert.ok(fan.includes("Kentucky Wildcats ML"));
});
