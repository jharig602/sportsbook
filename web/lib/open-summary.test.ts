import assert from "node:assert/strict";
import { test } from "node:test";

import { openSummary } from "./open-summary.ts";
import type { Bet, GradedRow, Score } from "./settle.ts";

function row(over: Partial<GradedRow> = {}): GradedRow {
  return {
    bet_id: "b1", placed_at: "2026-09-26T13:00:00Z", league: "nfl", event_id: "DET-NYJ",
    home_team: "Detroit Lions", away_team: "New York Jets", commence_time: "2026-09-27T17:00:00Z",
    market: "spread", side: "home", line: -6.5, price: 109, stake: 25, book: "FanDuel",
    model_probability: null, market_probability: null, rule_version_id: null, note: null,
    supersedes: null, outcome: "open", profit: 0, returned: 0, heldProfit: null,
    ...over,
  } as GradedRow;
}

const none = new Map<string, Score>();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("a boosted Lions spread: in play, if it wins, and what it is worth at a fair 50%", () => {
  const s = openSummary([row()], new Map(), () => 0.5, none);
  assert.equal(s.tickets, 1);
  assert.equal(s.atStake, 25);
  assert.ok(near(s.ifAllWin, 27.25));
  // 0.5 x 27.25 - 0.5 x 25
  assert.ok(near(s.expected, 1.125));
  assert.equal(s.unpriced, 0);
});

test("settled and cashed tickets are not in play", () => {
  const s = openSummary(
    [row({ outcome: "won", profit: 27.25 }), row({ bet_id: "c", outcome: "cashed" })],
    new Map(), () => 0.5, none,
  );
  assert.equal(s.tickets, 0);
  assert.equal(s.atStake, 0);
});

test("a ticket with no market is counted at break-even and said so", () => {
  const s = openSummary([row(), row({ bet_id: "b2", stake: 10 })], new Map(),
    (bet) => (bet.bet_id === "b1" ? 0.5 : null), none);
  assert.equal(s.unpriced, 1);
  assert.ok(near(s.expected, 1.125), "the unpriced one adds nothing either way");
  assert.equal(s.atStake, 35);
});

test("a losing bonus bet costs nothing, so its expected value is its winnings alone", () => {
  const s = openSummary([row({ bonus: true, price: 300, stake: 10 } as Partial<GradedRow>)], new Map(), () => 0.25, none);
  assert.equal(s.atStake, 0);
  assert.equal(s.bonusStake, 10);
  assert.ok(near(s.expected, 0.25 * 30));
});

test("a parlay multiplies its open legs and counts a won leg as certain", () => {
  const legs: Bet[] = [
    row({ bet_id: "l1", event_id: "A", parlay_id: "P", parlay_price: 260, stake: 5 }),
    row({ bet_id: "l2", event_id: "B", parlay_id: "P", parlay_price: 260, stake: 5, market: "moneyline", side: "home", line: null }),
  ];
  const ticket = row({ ...legs[0], parlay_id: "P", parlay_price: 260, stake: 5 } as Partial<GradedRow>);
  // Leg A is final and covered (home -6.5 won by 10).
  const scores = new Map<string, Score>([["A", { home_score: 27, away_score: 17 }]]);
  const s = openSummary([ticket], new Map([["P", legs]]), () => 0.6, scores);
  assert.ok(near(s.ifAllWin, 13));
  assert.ok(near(s.expected, 0.6 * 13 - 0.4 * 5));
});

test("two parlay legs on one game are not priced as independent", () => {
  const legs: Bet[] = [
    row({ bet_id: "l1", parlay_id: "S", parlay_price: 400, stake: 5 }),
    row({ bet_id: "l2", parlay_id: "S", parlay_price: 400, stake: 5, market: "total", side: "over", line: 44.5 }),
  ];
  const ticket = row({ ...legs[0] } as Partial<GradedRow>);
  const s = openSummary([ticket], new Map([["S", legs]]), () => 0.5, none);
  assert.equal(s.unpriced, 1);
  assert.equal(s.expected, 0);
});

test("each open ticket carries what holding it is worth, the bar a cash-out has to clear", () => {
  const s = openSummary([row()], new Map(), () => 0.5, none);
  const hold = s.hold.get("b1")!;
  assert.equal(hold.chance, 0.5);
  assert.ok(near(hold.value, 0.5 * (25 + 27.25)), "half of stake plus profit");
  const bonus = openSummary([row({ bonus: true, price: 300, stake: 10 } as Partial<GradedRow>)], new Map(), () => 0.25, none);
  assert.ok(near(bonus.hold.get("b1")!.value, 0.25 * 30), "a bonus bet returns only its profit");
  assert.equal(openSummary([row()], new Map(), () => null, none).hold.size, 0, "unpriced: no number offered");
});
