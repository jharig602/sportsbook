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

import { activeBets, type Bet, decimalOdds, didWin, settle, tally } from "./settle.ts";

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

const near = (a: number, b: number, msg?: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} != ${b}`);

// --- bonus bets -------------------------------------------------------------------

function bonusBet(over: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1",
    placed_at: "2026-09-12T18:00:00Z",
    league: "nfl",
    event_id: "401",
    home_team: "Jacksonville Jaguars",
    away_team: "Cleveland Browns",
    commence_time: "2026-09-13T17:00:00Z",
    market: "moneyline",
    side: "away",
    line: null,
    price: 360,
    stake: 50,
    book: "FanDuel",
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: "bonus bet",
    bonus: true,
    ...over,
  } as Bet;
}

test("a losing bonus bet costs nothing", () => {
  // The whole point. The stake was the book's, so a loss is not a loss. Recording it
  // as an ordinary wager books -$50 against a bet that cost $0 -- and bonus bets lose
  // most of the time, because taking long odds is exactly how you should use one.
  const lost = settle(bonusBet(), { home_score: 24, away_score: 10 });
  assert.equal(lost.outcome, "lost");
  assert.equal(lost.profit, 0);
  assert.equal(lost.returned, 0);
});

test("a winning bonus bet pays the winnings but not the stake back", () => {
  const won = settle(bonusBet(), { home_score: 10, away_score: 24 });
  assert.equal(won.outcome, "won");
  near(won.profit, 180, "$50 at +360 wins $180");
  near(won.returned, 180, "the $50 was never yours to get back");
});

test("an ordinary bet is unaffected", () => {
  const cash = bonusBet({ bonus: false });
  assert.equal(settle(cash, { home_score: 24, away_score: 10 }).profit, -50);
  near(settle(cash, { home_score: 10, away_score: 24 }).returned, 230);
});

test("ROI is measured against your own money only", () => {
  // A $50 bonus bet winning $180 is not a 360% return on anything you risked, and a
  // losing one is not a $50 hole. Neither belongs in the denominator.
  const scores = new Map([["401", { home_score: 10, away_score: 24 }]]);
  const { totals } = tally([bonusBet()], scores);
  near(totals.profit, 180);
  near(totals.bonusProfit, 180);
  assert.equal(totals.stakedSettled, 0);
  assert.equal(totals.roi, null, "nothing of yours was risked, so there is no return");
});

test("a bonus win does not inflate the ROI on cash bets", () => {
  const scores = new Map([
    ["401", { home_score: 10, away_score: 24 }],
    ["402", { home_score: 30, away_score: 10 }],
  ]);
  const cashLoss = bonusBet({
    bet_id: "b2", event_id: "402", bonus: false, stake: 100, side: "away",
  });
  const { totals } = tally([bonusBet(), cashLoss], scores);
  near(totals.profit, 80, "180 from the bonus, -100 on the cash bet");
  assert.equal(totals.stakedSettled, 100);
  near(totals.roi!, -1, "the cash bet lost its whole stake; the bonus is separate");
});

// --- corrections -------------------------------------------------------------------

function stub(bet_id: string, over: Partial<Bet> = {}): Bet {
  return {
    bet_id,
    placed_at: "2026-09-11T12:00:00Z",
    league: "nfl",
    event_id: "e1",
    home_team: "Home",
    away_team: "Away",
    commence_time: "2026-09-13T17:00:00Z",
    market: "moneyline",
    side: "away",
    line: null,
    price: 360,
    stake: 50,
    book: "FanDuel",
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: null,
    bonus: false,
    supersedes: null,
    ...over,
  };
}

test("a corrected bet is replaced by its correction, not counted alongside it", () => {
  // The failure this guards is silent and doubles the stake: both rows stand, and the
  // record counts one wager twice.
  const bets = [stub("new", { supersedes: "old", bonus: true }), stub("old")];
  const active = activeBets(bets);
  assert.deepEqual(active.map((b) => b.bet_id), ["new"]);
  assert.equal(active[0].bonus, true);
});

test("a chain of corrections leaves only the last one standing", () => {
  const bets = [
    stub("c", { supersedes: "b" }),
    stub("b", { supersedes: "a" }),
    stub("a"),
  ];
  assert.deepEqual(activeBets(bets).map((b) => b.bet_id), ["c"]);
});

test("a bet that names itself is kept, not vanished", () => {
  // A correction must never be able to delete a wager outright: the money was staked
  // whatever the ledger says, so the one outcome to refuse is an empty result.
  assert.deepEqual(activeBets([stub("x", { supersedes: "x" })]).map((b) => b.bet_id), ["x"]);
});

test("ordinary bets are untouched and keep their order", () => {
  const bets = [stub("one"), stub("two"), stub("three")];
  assert.deepEqual(activeBets(bets).map((b) => b.bet_id), ["one", "two", "three"]);
});

test("a correction naming an unknown bet still stands on its own", () => {
  // The API refuses these, but a row already in the table must not disappear from the
  // record because the thing it points at is missing.
  assert.deepEqual(activeBets([stub("new", { supersedes: "gone" })]).map((b) => b.bet_id), ["new"]);
});

test("an empty ledger corrects to an empty ledger", () => {
  assert.deepEqual(activeBets([]), []);
});

test("a voided bet drops out, and so does the void itself", () => {
  // A void is a tombstone, not a wager. Leaving it in the list would show a phantom
  // duplicate; leaving the original in would keep counting a bet that was never placed.
  const bets = [stub("void", { supersedes: "old", voided: true }), stub("old"), stub("keep")];
  assert.deepEqual(activeBets(bets).map((b) => b.bet_id), ["keep"]);
});

test("voiding one bet leaves the rest of the ledger alone", () => {
  const bets = [
    stub("a"),
    stub("void", { supersedes: "b", voided: true }),
    stub("b"),
    stub("c"),
  ];
  assert.deepEqual(activeBets(bets).map((b) => b.bet_id), ["a", "c"]);
});

test("a correction and a void can both sit in one chain", () => {
  // Corrected once, then removed. Nothing from the chain should survive.
  const bets = [
    stub("void", { supersedes: "fixed", voided: true }),
    stub("fixed", { supersedes: "original" }),
    stub("original"),
  ];
  assert.deepEqual(activeBets(bets), []);
});
