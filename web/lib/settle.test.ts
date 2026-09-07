/**
 * Settlement tests.
 *
 * This is the only code that turns a game into money, so the cases that matter are the
 * pushes and the sign conventions. A push counted as a loss quietly understates every
 * strategy that lands on key numbers, and a flipped spread sign makes a losing record
 * look profitable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Bet, decimalOdds, didWin, settle, tally } from "./settle.ts";

function bet(overrides: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1",
    placed_at: "2026-09-07T20:00:00.000Z",
    league: "ncaaf",
    event_id: "E1",
    home_team: "Florida State Seminoles",
    away_team: "SMU Mustangs",
    commence_time: "2026-09-08T03:30:00.000Z",
    market: "spread",
    side: "home",
    line: 3,
    price: -115,
    stake: 20,
    book: "BetMGM",
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: null,
    ...overrides,
  };
}

// --- odds ------------------------------------------------------------------------

test("decimal odds from american", () => {
  assert.equal(decimalOdds(100), 2);
  assert.equal(decimalOdds(-100), 2);
  assert.ok(Math.abs(decimalOdds(-115)! - 1.8696) < 0.001);
  assert.ok(Math.abs(decimalOdds(130)! - 2.3) < 1e-9);
});

test("an impossible price cannot be settled", () => {
  assert.equal(decimalOdds(50), null);
  assert.equal(settle(bet({ price: 50 }), { home_score: 30, away_score: 20 }).outcome, "open");
});

// --- spreads ---------------------------------------------------------------------

test("home dog covers by losing narrowly", () => {
  // FSU +3, loses by 2 -> covers.
  assert.equal(didWin(bet({ side: "home", line: 3 }), { home_score: 24, away_score: 26 }), true);
});

test("home dog covers by winning outright", () => {
  assert.equal(didWin(bet({ side: "home", line: 3 }), { home_score: 30, away_score: 20 }), true);
});

test("home dog loses when beaten by more than the number", () => {
  assert.equal(didWin(bet({ side: "home", line: 3 }), { home_score: 20, away_score: 30 }), false);
});

test("away favourite is graded from its own side", () => {
  // SMU -3, wins by 10 -> covers.
  assert.equal(didWin(bet({ side: "away", line: -3 }), { home_score: 20, away_score: 30 }), true);
  // SMU -3, wins by 2 -> does not cover.
  assert.equal(didWin(bet({ side: "away", line: -3 }), { home_score: 24, away_score: 26 }), false);
});

test("landing exactly on the number is a push, not a loss", () => {
  const push = settle(bet({ side: "home", line: 3 }), { home_score: 21, away_score: 24 });
  assert.equal(push.outcome, "push");
  assert.equal(push.profit, 0);
  assert.equal(push.returned, 20, "a push returns the stake");
});

test("both sides of a spread cannot both win", () => {
  const score = { home_score: 24, away_score: 30 };
  const home = didWin(bet({ side: "home", line: 3 }), score);
  const away = didWin(bet({ side: "away", line: -3 }), score);
  assert.notEqual(home, away);
});

// --- totals ----------------------------------------------------------------------

test("over and under settle against the combined score", () => {
  const score = { home_score: 31, away_score: 24 }; // 55
  assert.equal(didWin(bet({ market: "total", side: "over", line: 53.5 }), score), true);
  assert.equal(didWin(bet({ market: "total", side: "under", line: 53.5 }), score), false);
});

test("a total landing on the number pushes", () => {
  const score = { home_score: 30, away_score: 24 }; // 54
  assert.equal(didWin(bet({ market: "total", side: "over", line: 54 }), score), null);
});

// --- moneyline -------------------------------------------------------------------

test("moneyline follows the winner", () => {
  assert.equal(didWin(bet({ market: "moneyline", side: "home", line: null }),
                      { home_score: 30, away_score: 20 }), true);
  assert.equal(didWin(bet({ market: "moneyline", side: "away", line: null }),
                      { home_score: 30, away_score: 20 }), false);
});

test("a tie pushes the moneyline", () => {
  assert.equal(didWin(bet({ market: "moneyline", side: "home", line: null }),
                      { home_score: 24, away_score: 24 }), null);
});

// --- money -----------------------------------------------------------------------

test("a winning underdog pays the right profit", () => {
  const result = settle(bet({ market: "moneyline", side: "home", line: null, price: 130 }),
                        { home_score: 30, away_score: 20 });
  assert.equal(result.outcome, "won");
  assert.ok(Math.abs(result.profit - 26) < 1e-9, "20 at +130 wins 26");
  assert.ok(Math.abs(result.returned - 46) < 1e-9);
});

test("a losing bet loses exactly the stake", () => {
  const result = settle(bet(), { home_score: 10, away_score: 40 });
  assert.equal(result.outcome, "lost");
  assert.equal(result.profit, -20);
  assert.equal(result.returned, 0);
});

test("an unplayed game stays open and moves no money", () => {
  const result = settle(bet(), undefined);
  assert.equal(result.outcome, "open");
  assert.equal(result.profit, 0);
});

// --- tally -----------------------------------------------------------------------

test("ROI is null until something settles, never zero", () => {
  // Zero would read as "broke even" when the truth is "no information yet".
  const { totals } = tally([bet()], new Map());
  assert.equal(totals.roi, null);
  assert.equal(totals.open, 1);
});

test("ROI is measured against settled stake only", () => {
  const scores = new Map([["E1", { home_score: 30, away_score: 20 }]]);
  const { totals } = tally(
    [bet({ bet_id: "a", price: 100 }), bet({ bet_id: "b", event_id: "E2" })],
    scores,
  );
  assert.equal(totals.settled, 1);
  assert.equal(totals.open, 1);
  assert.equal(totals.stakedSettled, 20, "the open bet must not dilute ROI");
  assert.ok(Math.abs(totals.roi! - 1) < 1e-9, "20 profit on 20 settled stake is 100%");
});

test("pushes count as settled but move no money", () => {
  const scores = new Map([["E1", { home_score: 21, away_score: 24 }]]);
  const { totals } = tally([bet({ side: "home", line: 3 })], scores);
  assert.equal(totals.push, 1);
  assert.equal(totals.profit, 0);
  assert.equal(totals.roi, 0);
});
