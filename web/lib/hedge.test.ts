import assert from "node:assert/strict";
import { test } from "node:test";

import { findHedges, hedgeBestCase, opposed } from "./hedge.ts";
import { tally, type Bet, type Score } from "./settle.ts";

function bet(over: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1", placed_at: "2026-10-04T12:00:00Z", league: "nfl", event_id: "BUF-NE",
    home_team: "New England Patriots", away_team: "Buffalo Bills", commence_time: "2026-10-04T17:00:00Z",
    market: "moneyline", side: "away", line: null, price: -150, stake: 30, book: "FanDuel",
    model_probability: null, market_probability: null, rule_version_id: null, note: null, supersedes: null,
    ...over,
  } as Bet;
}

// Bills -150 for $30 and Patriots +200 (boosted) for $20: either way about +$10.
const bills = bet();
const pats = bet({ bet_id: "b2", side: "home", price: 200, stake: 20, book: "BetMGM" });
const billsWin = new Map<string, Score>([["BUF-NE", { home_score: 17, away_score: 24 }]]);

test("the two sides of a game are opposed; a spread and an over on it are not", () => {
  assert.equal(opposed(bills, pats), true);
  assert.equal(opposed(bills, bet({ bet_id: "s", market: "spread", side: "home", line: 3.5 })), true, "ML on one side, spread on the other");
  assert.equal(opposed(bills, bet({ bet_id: "o", market: "total", side: "over", line: 44.5 })), false);
  assert.equal(opposed(bet({ market: "total", side: "over", line: 44.5 }), bet({ bet_id: "u", market: "total", side: "under", line: 44.5 })), true);
  assert.equal(opposed(bills, bet({ bet_id: "x", event_id: "OTHER", side: "home" })), false, "different games");
});

test("a hedge counts as ONE result in the record, won by its net money", () => {
  const { totals, hedges } = tally([bills, pats], billsWin);
  assert.equal(hedges.length, 1);
  // Bills win $20, Patriots lose $20: net zero is a push. Make the Patriots stake $15.
  const { totals: t2 } = tally([bills, { ...pats, stake: 15 }], billsWin);
  assert.equal(t2.won, 1);
  assert.equal(t2.lost, 0);
  assert.equal(t2.placed, 1);
  assert.ok(Math.abs(t2.profit - 5) < 1e-9, "the money is the same either way: +$20 - $15");
  assert.equal(totals.push, 1, "net exactly zero is a push");
});

test("a hedge stays open until both bets settle, and other bets are untouched", () => {
  const other = bet({ bet_id: "c", event_id: "DAL-NYG", side: "home" });
  const { totals } = tally([bills, pats, other], new Map());
  assert.equal(totals.placed, 2, "one hedge plus one other bet");
  assert.equal(totals.open, 2);
});

test("an open hedge's best case is one side winning, never both", () => {
  // Bills win: +$20 - $20 Patriots stake = $0. Patriots win: +$40 - $30 = +$10.
  assert.ok(Math.abs(hedgeBestCase([bills, pats]) - 10) < 1e-9);
  assert.equal(findHedges([]).length, 0);
});
