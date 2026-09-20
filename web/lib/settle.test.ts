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

import {
  activeBets,
  type Bet,
  decimalOdds,
  didWin,
  groupParlays,
  heldInstead,
  settle,
  settleOnScore,
  settleParlay,
  tally,
} from "./settle.ts";

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

// --- parlays ------------------------------------------------------------------------

const won = (id: string) => ({ event_id: id, home_score: 30, away_score: 0 });
const lost = (id: string) => ({ event_id: id, home_score: 0, away_score: 30 });

function parlayLegs(ids: string[], price = 576): Bet[] {
  return ids.map((id) =>
    stub(`leg-${id}`, {
      parlay_id: "p1",
      parlay_price: price,
      event_id: id,
      market: "spread",
      side: "home",
      line: -3,
      price: -110,
      stake: 5,
    }),
  );
}

function scoreMap(entries: Array<{ event_id: string; home_score: number; away_score: number }>) {
  return new Map(entries.map((e) => [e.event_id, { home_score: e.home_score, away_score: e.away_score }]));
}

test("every leg must win for the parlay to win", () => {
  const legs = parlayLegs(["a", "b", "c"]);
  const all = settleParlay(legs, scoreMap([won("a"), won("b"), won("c")]));
  assert.equal(all.outcome, "won");
  // +576 on $5 pays $28.80.
  assert.ok(Math.abs(all.profit - 5 * 5.76) < 1e-9, `${all.profit}`);
});

test("one losing leg kills the ticket however well the others did", () => {
  const legs = parlayLegs(["a", "b", "c"]);
  const graded = settleParlay(legs, scoreMap([won("a"), won("b"), lost("c")]));
  assert.equal(graded.outcome, "lost");
  assert.equal(graded.profit, -5, "the stake is lost once, not once per leg");
});

test("a parlay with an ungraded leg is still open", () => {
  const legs = parlayLegs(["a", "b", "c"]);
  const graded = settleParlay(legs, scoreMap([won("a"), won("b")]));
  assert.equal(graded.outcome, "open");
  assert.equal(graded.profit, 0);
});

test("a losing leg settles the ticket even with another leg unplayed", () => {
  // No need to wait: the ticket is already dead.
  const legs = parlayLegs(["a", "b", "c"]);
  const graded = settleParlay(legs, scoreMap([lost("a")]));
  assert.equal(graded.outcome, "lost");
});

test("a pushed leg is reported as needing correction, not guessed at", () => {
  // The book drops the leg and re-prices the ticket, and the odds it credits are not
  // necessarily the product of what is left. Settling at any number here would be
  // wrong in somebody's favour.
  const legs = parlayLegs(["a", "b"]);
  const push = scoreMap([{ event_id: "a", home_score: 23, away_score: 20 }, won("b")]);
  const graded = settleParlay(legs, push);
  assert.equal(graded.needsCorrection, true);
  assert.equal(graded.outcome, "open");
  assert.equal(graded.profit, 0);
});

test("the combined price is the book's, not the product of the legs", () => {
  // Books round parlay odds down. Recomputing from the legs would pay better than the
  // ticket actually does, and the error would grow with every leg.
  const legs = parlayLegs(["a", "b", "c"], 500); // book paid +500, product is higher
  const graded = settleParlay(legs, scoreMap([won("a"), won("b"), won("c")]));
  assert.ok(Math.abs(graded.profit - 5 * 5) < 1e-9, `${graded.profit}`);
});

test("a parlay counts as one ticket in the tally, not one per leg", () => {
  // Three legs of a $5 ticket is $5 risked and one result -- not $15 and three.
  const legs = parlayLegs(["a", "b", "c"]);
  const { rows, totals } = tally(legs, scoreMap([won("a"), won("b"), won("c")]));
  assert.equal(rows.length, 1);
  assert.equal(totals.placed, 1);
  assert.equal(totals.won, 1);
  assert.equal(totals.staked, 5);
});

test("parlays and singles live in the same ledger without interfering", () => {
  const bets = [...parlayLegs(["a", "b"]), stub("solo", { event_id: "z", stake: 10 })];
  const { rows, totals } = tally(bets, scoreMap([won("a"), won("b"), won("z")]));
  assert.equal(rows.length, 2, "one parlay plus one single");
  assert.equal(totals.staked, 15);
});

test("grouping keeps ledger order and does not merge different tickets", () => {
  const a = stub("a1", { parlay_id: "A" });
  const b = stub("b1", { parlay_id: "B" });
  const a2 = stub("a2", { parlay_id: "A" });
  const single = stub("s");
  const grouped = groupParlays([a, b, a2, single]);
  assert.deepEqual(
    grouped.map((g) => (g.kind === "parlay" ? `${g.id}:${g.legs.length}` : "single")),
    ["A:2", "B:1", "single"],
  );
});

/* --- cashing out ------------------------------------------------------------------
 *
 * The one stored verdict in the ledger, and therefore the one that can disagree with
 * the score sitting next to it. These tests exist to keep that disagreement deliberate.
 */

test("a cashed ticket pays the agreed price, whatever the score did", () => {
  const cashed = bet({ market: "moneyline", side: "away", price: 920, stake: 50, bonus: true, cashout: 193.98 });
  // The bet went on to lose outright; the cash-out stands.
  const lost = settle(cashed, { home_score: 30, away_score: 10 });
  assert.equal(lost.outcome, "cashed");
  assert.equal(lost.profit, 193.98);
  // And it would have won; still stands.
  const won = settle(cashed, { home_score: 10, away_score: 30 });
  assert.equal(won.outcome, "cashed");
  assert.equal(won.profit, 193.98);
});

test("a cashed ticket settles before its game finishes", () => {
  // The whole point: the money is decided, the game is not. Falling through to "open"
  // would leave settled cash outside the totals until an unrelated event ended.
  const result = settle(bet({ bonus: true, cashout: 193.98 }), undefined);
  assert.equal(result.outcome, "cashed");
  assert.equal(result.profit, 193.98);
});

test("the bonus asymmetry carries over from a win", () => {
  // Bonus: the stake was never yours, so the whole cash-out is profit.
  assert.equal(settle(bet({ stake: 50, bonus: true, cashout: 193.98 }), undefined).profit, 193.98);
  // Ordinary: the stake comes back inside that figure, so only the rest is profit.
  assert.equal(settle(bet({ stake: 50, bonus: false, cashout: 193.98 }), undefined).profit, 143.98);
});

test("cashing out below the stake books a loss, not a win", () => {
  // Cutting a loss is a legitimate cash-out and must not read as profit.
  const result = settle(bet({ stake: 100, bonus: false, cashout: 40 }), undefined);
  assert.equal(result.outcome, "cashed");
  assert.equal(result.profit, -60);
  assert.equal(result.returned, 40);
});

test("zero is a cash-out, not an absent one", () => {
  // `cashout: 0` must not be swallowed by a falsy check and graded against the score.
  const result = settle(bet({ stake: 20, bonus: false, cashout: 0 }), { home_score: 40, away_score: 0 });
  assert.equal(result.outcome, "cashed");
  assert.equal(result.profit, -20);
});

test("an uncashed bet is untouched by any of this", () => {
  const plain = bet({ market: "moneyline", side: "home", price: -150, stake: 30 });
  assert.deepEqual(settle(plain, { home_score: 21, away_score: 17 }), settleOnScore(plain, { home_score: 21, away_score: 17 }));
  assert.equal(settle(plain, { home_score: 21, away_score: 17 }).outcome, "won");
});

test("the counterfactual says what holding would have paid", () => {
  const cashed = bet({ market: "moneyline", side: "away", price: 920, stake: 50, bonus: true, cashout: 193.98 });
  const scores = new Map([["E1", { home_score: 10, away_score: 30 }]]);
  // Held, it wins: 50 * 9.2. Compared with a tolerance because that product lands at
  // 459.99999999999994 in binary floating point, as every +920 winner in this ledger
  // always has.
  assert.ok(Math.abs(heldInstead(cashed, scores)! - 460) < 1e-9);
  // Held, it loses: a bonus bet costs nothing.
  assert.equal(heldInstead(cashed, new Map([["E1", { home_score: 30, away_score: 10 }]])), 0);
});

test("an ungraded counterfactual is null, never zero", () => {
  // Zero would read as "holding would have paid nothing", which is the most flattering
  // possible answer for the decision to cash out, and it would be made up.
  const cashed = bet({ bonus: true, cashout: 193.98 });
  assert.equal(heldInstead(cashed, new Map()), null);
  // And a bet nobody cashed has no counterfactual at all -- the result IS the result.
  assert.equal(heldInstead(bet(), new Map([["E1", { home_score: 1, away_score: 0 }]])), null);
});

test("the tally separates cashed tickets from won and lost", () => {
  const scores = new Map([["E1", { home_score: 10, away_score: 30 }]]);
  const { totals } = tally(
    [bet({ market: "moneyline", side: "away", price: 920, stake: 50, bonus: true, cashout: 193.98 })],
    scores,
  );
  assert.equal(totals.cashed, 1);
  assert.equal(totals.won, 0, "a cash-out is not a win");
  assert.equal(totals.lost, 0, "nor a loss");
  assert.equal(totals.settled, 1, "but it is settled");
  assert.equal(totals.cashedGraded, 1);
  assert.equal(totals.cashedTaken, 193.98);
  assert.ok(
    Math.abs(totals.cashedHeld! - 460) < 1e-9,
    "holding would have paid more, and it should say so",
  );
  assert.equal(totals.profit, 193.98, "the ledger books what was actually received");
});

test("an ungraded cash-out counts its money but not its verdict", () => {
  const { totals } = tally([bet({ bonus: true, cashout: 193.98 })], new Map());
  assert.equal(totals.cashed, 1);
  assert.equal(totals.profit, 193.98);
  assert.equal(totals.cashedGraded, 0);
  assert.equal(totals.cashedHeld, null, "no score yet, so no comparison to draw");
});

test("a cashed parlay is one ticket, not one per leg", () => {
  // The figure sits on every leg so any leg can be read for it. Counting it per leg
  // would report a three-leg ticket as three cash-outs worth the full amount each.
  const legs = [
    bet({ bet_id: "p1", event_id: "E1", parlay_id: "P", parlay_price: 600, stake: 20, cashout: 75 }),
    bet({ bet_id: "p2", event_id: "E2", parlay_id: "P", parlay_price: 600, stake: 20, cashout: 75 }),
  ];
  const { rows, totals } = tally(legs, new Map());
  assert.equal(rows.length, 1);
  assert.equal(totals.cashed, 1);
  assert.equal(totals.profit, 55, "cash received less the one stake");
  assert.equal(totals.staked, 20, "not 40");
});

// --- team totals ----------------------------------------------------------------

test("a team total grades on that team's points, not the game's", () => {
  // 31-17: the game goes over 45.5, the home team goes over 24.5, the away team does
  // not. A team total read as a game total would call all three the same way.
  const score = { home_score: 31, away_score: 17 };
  assert.equal(
    didWin(bet({ market: "total", side: "over", line: 45.5, team: null }), score),
    true,
  );
  assert.equal(
    didWin(bet({ market: "total", side: "over", line: 24.5, team: "home" }), score),
    true,
  );
  assert.equal(
    didWin(bet({ market: "total", side: "over", line: 24.5, team: "away" }), score),
    false,
  );
});

test("a team total lands on its number and pushes", () => {
  assert.equal(
    didWin(bet({ market: "total", side: "over", line: 24, team: "home" }), {
      home_score: 24,
      away_score: 17,
    }),
    null,
  );
});

test("a total with no team is still the game's, as every old row is", () => {
  // Nothing written before team totals existed carries a team, and all of it meant the
  // game. A default that guessed otherwise would silently regrade the whole season.
  assert.equal(
    didWin(bet({ market: "total", side: "under", line: 45.5 }), {
      home_score: 20,
      away_score: 17,
    }),
    true,
  );
});
