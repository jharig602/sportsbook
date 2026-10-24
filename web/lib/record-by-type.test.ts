import assert from "node:assert/strict";
import test from "node:test";

import { recordByType, ticketType } from "./record-by-type.ts";
import type { Bet, GradedRow } from "./settle.ts";

const row = (over: Partial<GradedRow>): GradedRow =>
  ({ bet_id: "x", event_id: "E1", stake: 10, bonus: false, outcome: "won", profit: 9.09, returned: 19.09, heldProfit: null, parlay_id: null, ...over }) as GradedRow;

test("a ticket's type: single, parlay across games, or same-game", () => {
  const legs = new Map<string, Bet[]>([
    ["P", [{ event_id: "A" }, { event_id: "B" }] as Bet[]],
    ["S", [{ event_id: "A" }, { event_id: "A" }, { event_id: "A" }] as Bet[]],
  ]);
  assert.equal(ticketType({ parlay_id: null }, legs), "single");
  assert.equal(ticketType({ parlay_id: "P" }, legs), "parlay");
  assert.equal(ticketType({ parlay_id: "S" }, legs), "sgp");
});

test("split by type: own money in ROI, bonus profit apart, open tickets left out, cash-outs by money", () => {
  const legs = new Map<string, Bet[]>([["S", [{ event_id: "A" }, { event_id: "A" }] as Bet[]]]);
  const rows = [
    row({}),
    row({ outcome: "lost", profit: -10, returned: 0 }),
    row({ bonus: true, profit: 30, outcome: "won" }),
    row({ parlay_id: "S", stake: 25, outcome: "won", profit: 48.75 }),
    row({ parlay_id: "S", stake: 25, outcome: "open", profit: 0 }),
    row({ outcome: "cashed", profit: 4 }),
  ];
  const [single, parlay, sgp] = recordByType(rows, legs);
  assert.deepEqual([single.tickets, single.won, single.lost], [4, 3, 1]);
  assert.ok(Math.abs(single.profit - (9.09 - 10 + 4)) < 1e-9 && single.staked === 30);
  assert.equal(single.bonusProfit, 30);
  assert.equal(parlay.tickets, 0);
  assert.equal(parlay.roi, null);
  assert.deepEqual([sgp.tickets, sgp.won], [1, 1]);
  assert.ok(Math.abs(sgp.roi! - 48.75 / 25) < 1e-9);
});
